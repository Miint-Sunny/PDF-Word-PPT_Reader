#[tauri::command]
async fn read_file_buffer(file_path: String) -> Result<Vec<u8>, String> {
    std::fs::read(&file_path).map_err(|e| e.to_string())
}

#[tauri::command]
async fn convert_to_pdf_if_needed(file_path: String) -> Result<String, String> {
    let path = std::path::Path::new(&file_path);
    let ext = path.extension().and_then(|s| s.to_str()).unwrap_or("").to_lowercase();
    
    if ext == "pdf" {
        return Ok(file_path);
    }
    
    if ext == "pptx" || ext == "ppt" || ext == "docx" || ext == "doc" {
        let temp_dir = std::env::temp_dir();
        let timestamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis();
        let temp_pdf_path = temp_dir.join(format!("ai_pdf_reader_temp_{}.pdf", timestamp));
        
        // Escape single quotes
        let safe_file_path = file_path.replace("'", "''");
        let safe_temp_pdf_path = temp_pdf_path.to_string_lossy().replace("'", "''");
        
        let ps_script = if ext.starts_with("ppt") {
            format!(
                r#"
                $ErrorActionPreference = 'Stop'
                try {{
                    $ppt = New-Object -ComObject PowerPoint.Application
                    $presentation = $ppt.Presentations.Open('{}', $true, $true, $false)
                    $presentation.SaveAs('{}', 32)
                    $presentation.Close()
                    Write-Output 'SUCCESS'
                }} catch {{
                    Write-Error $_.Exception.Message
                }}
                "#, safe_file_path, safe_temp_pdf_path
            )
        } else {
            format!(
                r#"
                $ErrorActionPreference = 'Stop'
                try {{
                    $word = New-Object -ComObject Word.Application
                    $word.Visible = $false
                    $doc = $word.Documents.Open('{}')
                    $doc.ExportAsFixedFormat('{}', 17)
                    $doc.Close()
                    Write-Output 'SUCCESS'
                }} catch {{
                    Write-Error $_.Exception.Message
                }}
                "#, safe_file_path, safe_temp_pdf_path
            )
        };
        
        let ps_file_path = temp_dir.join(format!("ai_pdf_reader_script_{}.ps1", timestamp));
        
        // Prepend UTF-8 BOM so Windows PowerShell reads Chinese paths correctly
        let mut script_content = vec![0xEF, 0xBB, 0xBF];
        script_content.extend(ps_script.as_bytes());
        std::fs::write(&ps_file_path, script_content).map_err(|e| e.to_string())?;
        
        let output = std::process::Command::new("powershell")
            .args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", &ps_file_path.to_string_lossy()])
            .output()
            .map_err(|e| e.to_string())?;
            
        let _ = std::fs::remove_file(&ps_file_path);
        
        // If the PDF file was successfully created, ignore non-fatal stderr warnings
        if temp_pdf_path.exists() {
            return Ok(temp_pdf_path.to_string_lossy().into_owned());
        }
        
        let err_msg = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Word/PPT Engine Error: {}", err_msg));
    }
    
    Err("Unsupported file format".to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![read_file_buffer, convert_to_pdf_if_needed])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
