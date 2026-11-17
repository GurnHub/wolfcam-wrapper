//! Prints the parsed summary of a demo as JSON: `cargo run --example demodump -- file.dm_91`
fn main() {
    let path = std::env::args().nth(1).expect("usage: demodump <demo file>");
    match wolfdeck_lib::demo::parse_file(std::path::Path::new(&path)) {
        Ok(info) => println!("{}", serde_json::to_string_pretty(&info).unwrap()),
        Err(e) => {
            eprintln!("error: {e}");
            std::process::exit(1);
        }
    }
}
