//! `loadout-ml embed --model <dir>`: reads texts (one JSON string per line) on stdin and writes one JSON array of floats per line
//! on stdout, the L2-normalised mean of the last hidden state, the same recipe as the `minilm_int8` variant measured in ml-eval.
//! The model directory holds `model.onnx` and `tokenizer.json`; the window checks their sha256 before it starts this program.
use std::io::{BufRead, Write};
use std::path::Path;

use ort::session::Session;
use ort::value::Tensor;

/// The measured recipe truncates at 128 tokens (the special tokens are kept).
const MAX_TOKENS: usize = 128;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let model = match args.as_slice() {
        [_, cmd, flag, dir] if cmd == "embed" && flag == "--model" => dir.clone(),
        _ => {
            eprintln!("usage: loadout-ml embed --model <dir>");
            std::process::exit(2);
        }
    };
    if let Err(e) = run(Path::new(&model)) {
        eprintln!("loadout-ml: {e}");
        std::process::exit(1);
    }
}

fn run(dir: &Path) -> Result<(), String> {
    let mut tok = tokenizers::Tokenizer::from_file(dir.join("tokenizer.json"))
        .map_err(|e| format!("tokenizer: {e}"))?;
    tok.with_truncation(Some(tokenizers::TruncationParams {
        max_length: MAX_TOKENS,
        ..Default::default()
    }))
    .map_err(|e| format!("tokenizer: {e}"))?;
    tok.with_padding(None);
    let env = ort::init()
        .build()
        .map_err(|e| format!("onnx runtime: {e}"))?;
    let mut session = Session::builder(&env)
        .map_err(|e| format!("onnx runtime: {e}"))?
        .with_intra_threads(2)
        .map_err(|e| format!("onnx runtime: {e}"))?
        .with_inter_threads(1)
        .map_err(|e| format!("onnx runtime: {e}"))?
        .commit_from_file(dir.join("model.onnx"))
        .map_err(|e| format!("model: {e}"))?;
    let stdin = std::io::stdin();
    let mut out = std::io::BufWriter::new(std::io::stdout().lock());
    for line in stdin.lock().lines() {
        let line = line.map_err(|e| e.to_string())?;
        if line.trim().is_empty() {
            continue;
        }
        let text: String = serde_json::from_str(&line).map_err(|e| format!("input: {e}"))?;
        let enc = tok
            .encode(text.as_str(), true)
            .map_err(|e| format!("tokenizer: {e}"))?;
        let ids: Vec<i64> = enc.get_ids().iter().map(|&x| i64::from(x)).collect();
        let n = ids.len();
        let tensor = |v: Vec<i64>| Tensor::from_array(([1usize, n], v)).map_err(|e| e.to_string());
        let outputs = session
            .run(ort::inputs![
                "input_ids" => tensor(ids)?,
                "attention_mask" => tensor(vec![1; n])?,
                "token_type_ids" => tensor(vec![0; n])?,
            ])
            .map_err(|e| format!("model: {e}"))?;
        let (shape, hidden) = outputs["last_hidden_state"]
            .try_extract_tensor::<f32>()
            .map_err(|e| format!("model: {e}"))?;
        let d = usize::try_from(shape[2]).map_err(|e| e.to_string())?;
        let v = mean_unit(hidden, n, d);
        serde_json::to_writer(&mut out, &v).map_err(|e| e.to_string())?;
        out.write_all(b"\n").map_err(|e| e.to_string())?;
        out.flush().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// The mean of `n` rows of `d` values, scaled to length 1 (the mean's own scale cancels out, so only the sum is needed).
fn mean_unit(h: &[f32], n: usize, d: usize) -> Vec<f32> {
    let mut v = vec![0f32; d];
    for row in h.chunks_exact(d).take(n) {
        for (s, x) in v.iter_mut().zip(row) {
            *s += x;
        }
    }
    let norm = v.iter().map(|x| x * x).sum::<f32>().sqrt();
    if norm > 0.0 {
        v.iter_mut().for_each(|x| *x /= norm);
    }
    v
}

#[cfg(test)]
mod tests {
    use super::mean_unit;

    #[test]
    fn the_mean_of_the_rows_has_length_one() {
        // rows (3, 0) and (0, 4): the sum (3, 4) has length 5
        let v = mean_unit(&[3.0, 0.0, 0.0, 4.0], 2, 2);
        assert!(
            (v[0] - 0.6).abs() < 1e-6 && (v[1] - 0.8).abs() < 1e-6,
            "{v:?}"
        );
        assert_eq!(mean_unit(&[0.0, 0.0], 1, 2), vec![0.0, 0.0]);
    }
}
