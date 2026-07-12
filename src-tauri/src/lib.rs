use serde::{Deserialize, Serialize};
use serde_json::json;
use std::path::{Path, PathBuf};

#[tauri::command]
async fn read_file_buffer(file_path: String) -> Result<Vec<u8>, String> {
    std::fs::read(&file_path).map_err(|e| e.to_string())
}

fn is_office_ext(ext: &str) -> bool {
    matches!(ext, "pptx" | "ppt" | "docx" | "doc")
}

#[tauri::command]
async fn convert_to_pdf_if_needed(file_path: String) -> Result<String, String> {
    let path = Path::new(&file_path);
    let ext = path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_lowercase();

    if ext == "pdf" {
        return Ok(file_path);
    }
    if !is_office_ext(&ext) {
        return Err("Unsupported file format".to_string());
    }

    let temp_dir = std::env::temp_dir();
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis();
    let temp_pdf_path = temp_dir.join(format!("ai_pdf_reader_temp_{}.pdf", timestamp));

    // Each platform branch produces `temp_pdf_path` (or returns a descriptive error).
    #[cfg(target_os = "windows")]
    convert_windows(&file_path, &ext, &temp_dir, timestamp, &temp_pdf_path)?;

    #[cfg(target_os = "macos")]
    convert_macos(&file_path, &ext, &temp_dir, timestamp, &temp_pdf_path)?;

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    convert_linux(&file_path, &temp_dir, timestamp, &temp_pdf_path)?;

    // Trust the produced file, not the process exit code.
    if temp_pdf_path.exists() {
        return Ok(temp_pdf_path.to_string_lossy().into_owned());
    }
    Err("Conversion failed: no PDF was produced.".to_string())
}

// ---------------------------------------------------------------------------
// Windows: drive native Office COM via a generated PowerShell script.
// (Preserved verbatim from the original implementation — including the
//  load-bearing UTF-8 BOM injection that keeps Chinese paths from mojibaking.)
// ---------------------------------------------------------------------------
#[cfg(target_os = "windows")]
fn convert_windows(
    file_path: &str,
    ext: &str,
    temp_dir: &Path,
    timestamp: u128,
    temp_pdf_path: &Path,
) -> Result<(), String> {
    // Escape single quotes
    let safe_file_path = file_path.replace('\'', "''");
    let safe_temp_pdf_path = temp_pdf_path.to_string_lossy().replace('\'', "''");

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
            "#,
            safe_file_path, safe_temp_pdf_path
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
            "#,
            safe_file_path, safe_temp_pdf_path
        )
    };

    let ps_file_path = temp_dir.join(format!("ai_pdf_reader_script_{}.ps1", timestamp));

    // Prepend UTF-8 BOM so Windows PowerShell reads Chinese paths correctly
    let mut script_content = vec![0xEF, 0xBB, 0xBF];
    script_content.extend(ps_script.as_bytes());
    std::fs::write(&ps_file_path, script_content).map_err(|e| e.to_string())?;

    let output = std::process::Command::new("powershell")
        .args([
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            &ps_file_path.to_string_lossy(),
        ])
        .output()
        .map_err(|e| e.to_string())?;

    let _ = std::fs::remove_file(&ps_file_path);

    if temp_pdf_path.exists() {
        return Ok(());
    }
    Err(format!(
        "Word/PPT Engine Error: {}",
        String::from_utf8_lossy(&output.stderr)
    ))
}

// ---------------------------------------------------------------------------
// macOS: no COM. Try, in order of fidelity/reliability:
//   1. LibreOffice headless CLI (best default, no MS Office license needed)
//   2. Microsoft Word/PowerPoint via osascript (highest fidelity, if installed)
//   3. Pages/Keynote via osascript (always present, lowest fidelity)
// Engines are detected on the filesystem at runtime; nothing is installed.
// ---------------------------------------------------------------------------
#[cfg(target_os = "macos")]
fn convert_macos(
    file_path: &str,
    ext: &str,
    temp_dir: &Path,
    timestamp: u128,
    temp_pdf_path: &Path,
) -> Result<(), String> {
    let is_ppt = ext.starts_with("ppt");
    let mut errors: Vec<String> = Vec::new();

    // 1. LibreOffice
    if let Some(soffice) = find_libreoffice_macos() {
        match libreoffice_convert(&soffice, file_path, temp_dir, timestamp, temp_pdf_path) {
            Ok(()) => return Ok(()),
            Err(e) => errors.push(format!("LibreOffice: {}", e)),
        }
    }

    // 2. Microsoft Office
    let ms_app = if is_ppt { "Microsoft PowerPoint" } else { "Microsoft Word" };
    if app_bundle_exists(ms_app) {
        match osascript_ms_office(file_path, is_ppt, temp_pdf_path) {
            Ok(()) => return Ok(()),
            Err(e) => errors.push(format!("{}: {}", ms_app, e)),
        }
    }

    // 3. iWork (Pages / Keynote)
    let iwork_app = if is_ppt { "Keynote" } else { "Pages" };
    if app_bundle_exists(iwork_app) {
        match osascript_iwork(file_path, is_ppt, temp_pdf_path) {
            Ok(()) => return Ok(()),
            Err(e) => errors.push(format!("{}: {}", iwork_app, e)),
        }
    }

    if errors.is_empty() {
        Err("No Office-to-PDF engine found on this Mac. Install LibreOffice \
             (https://www.libreoffice.org/download/) to enable Word/PPT conversion."
            .to_string())
    } else {
        Err(format!("Office conversion failed. {}", errors.join(" | ")))
    }
}

#[cfg(target_os = "macos")]
fn find_libreoffice_macos() -> Option<PathBuf> {
    let system = PathBuf::from("/Applications/LibreOffice.app/Contents/MacOS/soffice");
    if system.exists() {
        return Some(system);
    }
    if let Some(home) = std::env::var_os("HOME") {
        let user = PathBuf::from(home)
            .join("Applications/LibreOffice.app/Contents/MacOS/soffice");
        if user.exists() {
            return Some(user);
        }
    }
    None
}

#[cfg(target_os = "macos")]
fn app_bundle_exists(app_name: &str) -> bool {
    PathBuf::from(format!("/Applications/{}.app", app_name)).exists()
}

// Escape a POSIX path for embedding inside an AppleScript double-quoted string.
#[cfg(target_os = "macos")]
fn applescript_escape(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"")
}

#[cfg(target_os = "macos")]
fn run_osascript(script: &str, temp_pdf_path: &Path) -> Result<(), String> {
    let output = std::process::Command::new("osascript")
        .arg("-e")
        .arg(script)
        .output()
        .map_err(|e| e.to_string())?;
    if temp_pdf_path.exists() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(stderr.trim().to_string())
    }
}

#[cfg(target_os = "macos")]
fn osascript_ms_office(file_path: &str, is_ppt: bool, temp_pdf_path: &Path) -> Result<(), String> {
    let in_path = applescript_escape(file_path);
    let out_path = applescript_escape(&temp_pdf_path.to_string_lossy());
    let script = if is_ppt {
        format!(
            "tell application \"Microsoft PowerPoint\"\n\
             set p to open \"{in_p}\"\n\
             save p in (POSIX file \"{out_p}\") as save as PDF\n\
             close p saving no\n\
             end tell",
            in_p = in_path,
            out_p = out_path
        )
    } else {
        format!(
            "tell application \"Microsoft Word\"\n\
             set d to open file name (POSIX file \"{in_p}\")\n\
             save as d file name (POSIX file \"{out_p}\") file format format PDF\n\
             close d saving no\n\
             end tell",
            in_p = in_path,
            out_p = out_path
        )
    };
    run_osascript(&script, temp_pdf_path)
}

#[cfg(target_os = "macos")]
fn osascript_iwork(file_path: &str, is_ppt: bool, temp_pdf_path: &Path) -> Result<(), String> {
    let in_path = applescript_escape(file_path);
    let out_path = applescript_escape(&temp_pdf_path.to_string_lossy());
    let app = if is_ppt { "Keynote" } else { "Pages" };
    let script = format!(
        "tell application \"{app}\"\n\
         set d to open (POSIX file \"{in_p}\")\n\
         export d to file (POSIX file \"{out_p}\") as PDF\n\
         close d saving no\n\
         end tell",
        app = app,
        in_p = in_path,
        out_p = out_path
    );
    run_osascript(&script, temp_pdf_path)
}

// ---------------------------------------------------------------------------
// Linux (and other unix): LibreOffice headless only.
// ---------------------------------------------------------------------------
#[cfg(not(any(target_os = "windows", target_os = "macos")))]
fn convert_linux(
    file_path: &str,
    temp_dir: &Path,
    timestamp: u128,
    temp_pdf_path: &Path,
) -> Result<(), String> {
    let soffice = find_libreoffice_unix().ok_or_else(|| {
        "LibreOffice not found. Install it to enable Office-to-PDF conversion.".to_string()
    })?;
    libreoffice_convert(&soffice, file_path, temp_dir, timestamp, temp_pdf_path)
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
fn find_libreoffice_unix() -> Option<PathBuf> {
    for c in ["/usr/bin/soffice", "/usr/bin/libreoffice", "/snap/bin/libreoffice"] {
        let p = PathBuf::from(c);
        if p.exists() {
            return Some(p);
        }
    }
    None
}

// Shared LibreOffice headless conversion (macOS + Linux).
// Uses a per-call UserInstallation profile so concurrent conversions don't
// deadlock on the shared profile lock, and validates the output file exists
// rather than trusting the exit code (soffice can SIGABRT yet still succeed).
#[cfg(any(target_os = "macos", target_os = "linux"))]
fn libreoffice_convert(
    soffice: &Path,
    file_path: &str,
    temp_dir: &Path,
    timestamp: u128,
    temp_pdf_path: &Path,
) -> Result<(), String> {
    let out_dir = temp_dir.join(format!("ai_pdf_reader_out_{}", timestamp));
    std::fs::create_dir_all(&out_dir).map_err(|e| e.to_string())?;

    let profile_dir = temp_dir.join(format!("ai_pdf_reader_lo_profile_{}", timestamp));
    let user_install = format!(
        "-env:UserInstallation=file://{}",
        profile_dir.to_string_lossy()
    );

    let output = std::process::Command::new(soffice)
        .arg(&user_install)
        .args([
            "--headless",
            "--nologo",
            "--norestore",
            "--nolockcheck",
            "--convert-to",
            "pdf",
            "--outdir",
        ])
        .arg(&out_dir)
        .arg(file_path)
        .output()
        .map_err(|e| e.to_string())?;

    // LibreOffice names the output after the input stem.
    let stem = Path::new(file_path)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("output");
    let produced = out_dir.join(format!("{}.pdf", stem));

    let result = if produced.exists() {
        std::fs::rename(&produced, temp_pdf_path).map_err(|e| e.to_string())
    } else {
        Err(format!(
            "soffice produced no PDF. stderr: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ))
    };

    let _ = std::fs::remove_dir_all(&out_dir);
    let _ = std::fs::remove_dir_all(&profile_dir);
    result
}

// ===========================================================================
// Multi-provider LLM chat. All network calls run here in Rust (reqwest) so the
// WebView never hits CORS/browser-guard walls and API keys / service-account
// credentials stay out of the JS bundle. Message shape is multimodal-ready:
// each message may carry base64 image parts (used later for Gemini's native
// vision over PPT images/charts).
// ===========================================================================

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ImagePart {
    mime_type: String,
    /// Base64-encoded image bytes (no `data:` prefix).
    data: String,
}

#[derive(Deserialize)]
struct ChatMessage {
    /// "user" | "assistant" | "system"
    role: String,
    #[serde(default)]
    content: String,
    #[serde(default)]
    images: Vec<ImagePart>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct VertexCreds {
    project: String,
    location: String,
    /// The raw service-account JSON string.
    service_account_json: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LlmRequest {
    /// "openai" | "gemini" | "vertex"
    provider: String,
    model: String,
    #[serde(default)]
    system: String,
    messages: Vec<ChatMessage>,
    #[serde(default)]
    api_key: Option<String>,
    #[serde(default)]
    base_url: Option<String>,
    #[serde(default)]
    vertex: Option<VertexCreds>,
}

#[tauri::command]
async fn llm_chat(req: LlmRequest) -> Result<String, String> {
    match req.provider.as_str() {
        "openai" => openai_chat(&req).await,
        "gemini" => gemini_chat(&req).await,
        "vertex" => vertex_chat(&req).await,
        other => Err(format!("Unknown provider: {}", other)),
    }
}

async fn openai_chat(req: &LlmRequest) -> Result<String, String> {
    let api_key = req
        .api_key
        .as_ref()
        .ok_or("OpenAI API key is required")?;
    let base = req
        .base_url
        .clone()
        .unwrap_or_else(|| "https://api.openai.com/v1".to_string());
    let url = format!("{}/chat/completions", base.trim_end_matches('/'));

    let mut messages: Vec<serde_json::Value> = Vec::new();
    if !req.system.is_empty() {
        messages.push(json!({ "role": "system", "content": req.system }));
    }
    for m in &req.messages {
        let role = match m.role.as_str() {
            "assistant" => "assistant",
            "system" => "system",
            _ => "user",
        };
        if m.images.is_empty() {
            messages.push(json!({ "role": role, "content": m.content }));
        } else {
            let mut parts = vec![json!({ "type": "text", "text": m.content })];
            for img in &m.images {
                parts.push(json!({
                    "type": "image_url",
                    "image_url": { "url": format!("data:{};base64,{}", img.mime_type, img.data) }
                }));
            }
            messages.push(json!({ "role": role, "content": parts }));
        }
    }

    let body = json!({ "model": req.model, "messages": messages, "temperature": 0.2 });

    let resp = reqwest::Client::new()
        .post(&url)
        .header("Authorization", format!("Bearer {}", api_key))
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let status = resp.status();
    let text = resp.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("OpenAI API error ({}): {}", status, text));
    }
    let v: serde_json::Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    Ok(v["choices"][0]["message"]["content"]
        .as_str()
        .unwrap_or("")
        .to_string())
}

/// Gemini + Vertex share the `generateContent` schema; only URL and auth differ.
fn build_gemini_body(req: &LlmRequest) -> serde_json::Value {
    let mut contents: Vec<serde_json::Value> = Vec::new();
    let mut sys_texts: Vec<String> = Vec::new();
    if !req.system.is_empty() {
        sys_texts.push(req.system.clone());
    }
    for m in &req.messages {
        if m.role == "system" {
            if !m.content.is_empty() {
                sys_texts.push(m.content.clone());
            }
            continue;
        }
        let role = if m.role == "assistant" { "model" } else { "user" };
        let mut parts: Vec<serde_json::Value> = Vec::new();
        if !m.content.is_empty() {
            parts.push(json!({ "text": m.content }));
        }
        for img in &m.images {
            parts.push(json!({ "inlineData": { "mimeType": img.mime_type, "data": img.data } }));
        }
        if parts.is_empty() {
            continue;
        }
        contents.push(json!({ "role": role, "parts": parts }));
    }

    let mut body = json!({ "contents": contents, "generationConfig": { "temperature": 0.2 } });
    if !sys_texts.is_empty() {
        body["systemInstruction"] = json!({ "parts": [{ "text": sys_texts.join("\n\n") }] });
    }
    body
}

fn parse_gemini_response(text: &str) -> Result<String, String> {
    let v: serde_json::Value = serde_json::from_str(text).map_err(|e| e.to_string())?;
    if let Some(parts) = v["candidates"][0]["content"]["parts"].as_array() {
        let joined: String = parts
            .iter()
            .filter_map(|p| p["text"].as_str())
            .collect::<Vec<_>>()
            .join("");
        if !joined.is_empty() {
            return Ok(joined);
        }
    }
    Err(format!("Unexpected Gemini response: {}", text))
}

async fn gemini_chat(req: &LlmRequest) -> Result<String, String> {
    let api_key = req
        .api_key
        .as_ref()
        .ok_or("Gemini API key is required")?;
    let url = format!(
        "https://generativelanguage.googleapis.com/v1beta/models/{}:generateContent",
        req.model
    );
    let resp = reqwest::Client::new()
        .post(&url)
        .header("x-goog-api-key", api_key.as_str())
        .json(&build_gemini_body(req))
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let status = resp.status();
    let text = resp.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("Gemini API error ({}): {}", status, text));
    }
    parse_gemini_response(&text)
}

async fn vertex_chat(req: &LlmRequest) -> Result<String, String> {
    let creds = req.vertex.as_ref().ok_or(
        "Vertex credentials (project, location, service account JSON) are required",
    )?;
    let token = mint_vertex_token(&creds.service_account_json).await?;
    let url = format!(
        "https://{loc}-aiplatform.googleapis.com/v1/projects/{proj}/locations/{loc}/publishers/google/models/{model}:generateContent",
        loc = creds.location,
        proj = creds.project,
        model = req.model
    );
    let resp = reqwest::Client::new()
        .post(&url)
        .header("Authorization", format!("Bearer {}", token))
        .json(&build_gemini_body(req))
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let status = resp.status();
    let text = resp.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("Vertex API error ({}): {}", status, text));
    }
    parse_gemini_response(&text)
}

#[derive(Deserialize)]
struct ServiceAccountKey {
    client_email: String,
    private_key: String,
    token_uri: Option<String>,
}

#[derive(Serialize)]
struct JwtClaims {
    iss: String,
    scope: String,
    aud: String,
    iat: u64,
    exp: u64,
}

/// Two-legged OAuth (JWT-bearer) exchange to get a short-lived Vertex access token
/// from a service-account key — done in Rust so the private key never reaches JS.
async fn mint_vertex_token(sa_json: &str) -> Result<String, String> {
    let key: ServiceAccountKey = serde_json::from_str(sa_json)
        .map_err(|e| format!("Invalid service account JSON: {}", e))?;
    let token_uri = key
        .token_uri
        .clone()
        .unwrap_or_else(|| "https://oauth2.googleapis.com/token".to_string());

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    let claims = JwtClaims {
        iss: key.client_email.clone(),
        scope: "https://www.googleapis.com/auth/cloud-platform".to_string(),
        aud: token_uri.clone(),
        iat: now,
        exp: now + 3600,
    };

    let header = jsonwebtoken::Header::new(jsonwebtoken::Algorithm::RS256);
    let enc_key = jsonwebtoken::EncodingKey::from_rsa_pem(key.private_key.as_bytes())
        .map_err(|e| format!("Invalid service account private key: {}", e))?;
    let jwt = jsonwebtoken::encode(&header, &claims, &enc_key)
        .map_err(|e| format!("Failed to sign JWT: {}", e))?;

    let params = [
        ("grant_type", "urn:ietf:params:oauth:grant-type:jwt-bearer"),
        ("assertion", jwt.as_str()),
    ];
    let resp = reqwest::Client::new()
        .post(&token_uri)
        .form(&params)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let status = resp.status();
    let text = resp.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("Vertex token exchange failed ({}): {}", status, text));
    }
    let v: serde_json::Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    v["access_token"]
        .as_str()
        .map(|s| s.to_string())
        .ok_or_else(|| format!("No access_token in token response: {}", text))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            read_file_buffer,
            convert_to_pdf_if_needed,
            llm_chat
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
