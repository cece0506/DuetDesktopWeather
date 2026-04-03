use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::Manager;
use std::io::Write;
use std::thread::sleep;
use std::time::Duration;

#[derive(serde::Serialize)]
struct RuntimeConfigResponse {
  qq_map_key: Option<String>,
}

const DEFAULT_RUNTIME_CONFIG_TEXT: &str = include_str!("../../app-config.json");

#[derive(serde::Serialize)]
struct LocationCity {
  id: String,
  title: String,
  adcode: String,
  latitude: f64,
  longitude: f64,
  source: String,
}

#[derive(serde::Serialize)]
struct LocationLookupResponse {
  city: Option<LocationCity>,
  reason: Option<String>,
}

#[derive(serde::Deserialize, serde::Serialize, Default)]
struct RuntimeConfigFile {
  qq_map_key: Option<String>,
  enable_daily_log: Option<bool>,
}

fn runtime_config_candidates() -> Vec<std::path::PathBuf> {
  let mut candidates = Vec::new();

  let mut push_with_ancestors = |start: std::path::PathBuf| {
    let mut current = Some(start);
    for _ in 0..6 {
      if let Some(dir) = current {
        candidates.push(dir.join("app-config.json"));
        current = dir.parent().map(|p| p.to_path_buf());
      } else {
        break;
      }
    }
  };

  if let Ok(exe) = std::env::current_exe() {
    if let Some(exe_dir) = exe.parent() {
      push_with_ancestors(exe_dir.to_path_buf());
    }
  }
  if let Ok(cwd) = std::env::current_dir() {
    push_with_ancestors(cwd);
  }

  candidates
}

fn resolve_writable_runtime_config_path() -> std::path::PathBuf {
  for path in runtime_config_candidates() {
    if path.exists() {
      return path;
    }
  }

  if let Ok(cwd) = std::env::current_dir() {
    return cwd.join("app-config.json");
  }
  if let Ok(exe) = std::env::current_exe() {
    if let Some(exe_dir) = exe.parent() {
      return exe_dir.join("app-config.json");
    }
  }

  std::path::PathBuf::from("app-config.json")
}

#[derive(serde::Deserialize)]
struct QqLocationApiResponse {
  status: i32,
  message: Option<String>,
  result: Option<QqLocationResult>,
}

#[derive(serde::Deserialize)]
struct QqLocationResult {
  location: Option<QqLocationPoint>,
  ad_info: Option<QqAdInfo>,
}

#[derive(serde::Deserialize)]
struct QqLocationPoint {
  lat: f64,
  lng: f64,
}

#[derive(serde::Deserialize)]
struct QqAdInfo {
  province: Option<String>,
  city: Option<String>,
  district: Option<String>,
  adcode: Option<serde_json::Value>,
}

#[derive(serde::Deserialize)]
struct WeatherCityInput {
  id: String,
  title: String,
  adcode: String,
  source: String,
}

#[derive(serde::Serialize)]
struct WeatherDay {
  date: String,
  weather: String,
  #[serde(rename = "tempMax")]
  temp_max: i64,
  #[serde(rename = "tempMin")]
  temp_min: i64,
}

#[derive(serde::Serialize)]
struct WeatherCityResult {
  id: String,
  title: String,
  source: String,
  days: Vec<WeatherDay>,
}

#[derive(serde::Serialize)]
struct WeatherBatchResponse {
  items: Vec<WeatherCityResult>,
  updated_at: Option<String>,
  reason: Option<String>,
}

#[derive(serde::Deserialize)]
struct QqWeatherResponse {
  status: i32,
  #[serde(rename = "message")]
  _message: Option<String>,
  result: Option<QqWeatherResult>,
}

#[derive(serde::Deserialize)]
struct QqWeatherResult {
  forecast: Option<Vec<QqForecastContainer>>,
}

#[derive(serde::Deserialize)]
struct QqForecastContainer {
  update_time: Option<String>,
  infos: Vec<QqForecastDay>,
}

#[derive(serde::Deserialize)]
struct QqForecastDay {
  date: String,
  day: QqForecastPart,
  night: QqForecastPart,
}

#[derive(serde::Deserialize)]
struct QqForecastPart {
  weather: Option<String>,
  temperature: Option<serde_json::Value>,
}

fn json_to_string(value: &serde_json::Value) -> Option<String> {
  match value {
    serde_json::Value::String(v) => Some(v.to_string()),
    serde_json::Value::Number(v) => Some(v.to_string()),
    _ => None,
  }
}

fn json_to_i64(value: &serde_json::Value) -> Option<i64> {
  match value {
    serde_json::Value::Number(v) => v.as_i64(),
    serde_json::Value::String(v) => v.trim().parse::<i64>().ok(),
    _ => None,
  }
}

fn resolve_logs_dir() -> Option<std::path::PathBuf> {
  let mut candidates = Vec::new();

  if let Ok(cwd) = std::env::current_dir() {
    candidates.push(cwd.join("logs"));
  }
  if let Ok(exe) = std::env::current_exe() {
    if let Some(exe_dir) = exe.parent() {
      candidates.push(exe_dir.join("logs"));
    }
  }

  for path in candidates {
    if std::fs::create_dir_all(&path).is_ok() {
      return Some(path);
    }
  }

  None
}

fn cleanup_old_logs(log_dir: &std::path::Path) {
  let Ok(read_dir) = std::fs::read_dir(log_dir) else {
    return;
  };

  let today = chrono::Local::now().date_naive();
  for entry in read_dir.flatten() {
    let path = entry.path();
    let Some(name) = path.file_name().and_then(|v| v.to_str()) else {
      continue;
    };

    if !name.ends_with(".log") {
      continue;
    }

    let date_part = name.trim_end_matches(".log");
    let Ok(file_date) = chrono::NaiveDate::parse_from_str(date_part, "%Y-%m-%d") else {
      continue;
    };

    let age = (today - file_date).num_days();
    if age > 2 {
      let _ = std::fs::remove_file(path);
    }
  }
}

fn write_daily_log(runtime: &RuntimeConfigFile, category: &str, message: &str) {
  if runtime.enable_daily_log == Some(false) {
    return;
  }

  let Some(log_dir) = resolve_logs_dir() else {
    return;
  };

  cleanup_old_logs(&log_dir);

  let now = chrono::Local::now();
  let file_name = format!("{}.log", now.format("%Y-%m-%d"));
  let path = log_dir.join(file_name);

  if let Ok(mut file) = std::fs::OpenOptions::new()
    .create(true)
    .append(true)
    .open(path)
  {
    let line = format!(
      "[{}] [{}] {}\n",
      now.format("%H:%M:%S"),
      category,
      message.replace('\n', "\\n")
    );
    let _ = file.write_all(line.as_bytes());
  }
}

fn read_runtime_config() -> RuntimeConfigResponse {
  let parsed = read_runtime_config_file();
  let key = parsed
    .qq_map_key
    .map(|v| v.trim().to_string())
    .filter(|v| !v.is_empty());
  RuntimeConfigResponse { qq_map_key: key }
}

fn read_runtime_config_file() -> RuntimeConfigFile {
  for path in runtime_config_candidates() {
    if let Ok(text) = std::fs::read_to_string(path) {
      if let Ok(parsed) = serde_json::from_str::<RuntimeConfigFile>(&text) {
        return parsed;
      }
    }
  }

  if let Ok(parsed) = serde_json::from_str::<RuntimeConfigFile>(DEFAULT_RUNTIME_CONFIG_TEXT) {
    return parsed;
  }

  RuntimeConfigFile::default()
}

#[tauri::command]
fn save_runtime_config(raw_json: String) -> Result<String, String> {
  let mut parsed = serde_json::from_str::<RuntimeConfigFile>(&raw_json)
    .map_err(|err| format!("配置文件不是合法 JSON: {}", err))?;

  parsed.qq_map_key = parsed
    .qq_map_key
    .map(|v| v.trim().to_string())
    .filter(|v| !v.is_empty());

  let path = resolve_writable_runtime_config_path();
  let text = serde_json::to_string_pretty(&parsed)
    .map_err(|err| format!("配置序列化失败: {}", err))?;

  std::fs::write(&path, text)
    .map_err(|err| format!("保存配置失败: {}", err))?;

  Ok(format!("配置已保存到 {}", path.display()))
}

#[tauri::command]
fn save_config_template_via_dialog() -> Result<String, String> {
  let Some(path) = rfd::FileDialog::new()
    .set_file_name("app-config.template.json")
    .add_filter("JSON", &["json"])
    .save_file()
  else {
    return Err("已取消保存模板".to_string());
  };

  let template = serde_json::json!({
    "qq_map_key": "您的腾讯WebService API Key",
    "enable_daily_log": false
  });
  let text = serde_json::to_string_pretty(&template)
    .map_err(|err| format!("模板序列化失败: {}", err))?;

  std::fs::write(&path, text)
    .map_err(|err| format!("模板写入失败: {}", err))?;

  Ok(format!("模板已保存到 {}", path.display()))
}

#[tauri::command]
fn get_runtime_config() -> RuntimeConfigResponse {
  read_runtime_config()
}

#[tauri::command]
fn get_current_location() -> LocationLookupResponse {
  let runtime = read_runtime_config_file();
  let config = read_runtime_config();
  let Some(key) = config.qq_map_key else {
    write_daily_log(&runtime, "location", "missing qq_map_key");
    return LocationLookupResponse {
      city: None,
      reason: Some("未配置腾讯定位 Key，已隐藏当前位置".to_string()),
    };
  };

  let endpoint = format!(
    "https://apis.map.qq.com/ws/location/v1/ip?key={}",
    urlencoding::encode(&key)
  );
  write_daily_log(&runtime, "location", &format!("request endpoint={}", endpoint));

  let response = match reqwest::blocking::get(&endpoint) {
    Ok(response) => response,
    Err(err) => {
      write_daily_log(&runtime, "location", &format!("request error={}", err));
      return LocationLookupResponse {
        city: None,
        reason: Some(format!("腾讯定位接口请求失败: {}", err)),
      };
    }
  };

  let status = response.status();
  let body = match response.text() {
    Ok(text) => text,
    Err(err) => {
      write_daily_log(&runtime, "location", &format!("read body error={}", err));
      return LocationLookupResponse {
        city: None,
        reason: Some(format!("腾讯定位响应读取失败: {}", err)),
      };
    }
  };

  let body_preview = body.chars().take(300).collect::<String>();
  write_daily_log(
    &runtime,
    "location",
    &format!("response status={} body_preview={}", status, body_preview),
  );

  let payload: QqLocationApiResponse = match serde_json::from_str(&body) {
    Ok(payload) => payload,
    Err(err) => {
      write_daily_log(&runtime, "location", &format!("decode error={}", err));
      return LocationLookupResponse {
        city: None,
        reason: Some(format!("腾讯定位响应解析失败: {}", err)),
      };
    }
  };

  if payload.status != 0 {
    return LocationLookupResponse {
      city: None,
      reason: Some(format!(
        "腾讯定位接口返回异常: {}",
        payload.message.unwrap_or_else(|| "unknown".to_string())
      )),
    };
  }

  let Some(result) = payload.result else {
    return LocationLookupResponse {
      city: None,
      reason: Some("腾讯定位未返回结果".to_string()),
    };
  };

  let Some(location) = result.location else {
    return LocationLookupResponse {
      city: None,
      reason: Some("腾讯定位未返回经纬度".to_string()),
    };
  };

  let ad_info = result.ad_info;
  let province = ad_info.as_ref().and_then(|info| info.province.clone()).unwrap_or_default();
  let city = ad_info.as_ref().and_then(|info| info.city.clone()).unwrap_or_default();
  let district = ad_info.as_ref().and_then(|info| info.district.clone()).unwrap_or_default();
  let adcode = ad_info
    .as_ref()
    .and_then(|info| info.adcode.as_ref())
    .and_then(json_to_string)
    .unwrap_or_default();
  let title = format!("当前位置-{}{}{}", province, city, district);

  write_daily_log(
    &runtime,
    "location",
    &format!("ok title={} adcode={}", title, adcode),
  );

  LocationLookupResponse {
    city: Some(LocationCity {
      id: format!("{:.4},{:.4}", location.lat, location.lng),
      title,
      adcode,
      latitude: location.lat,
      longitude: location.lng,
      source: "location".to_string(),
    }),
    reason: None,
  }
}

#[tauri::command]
fn get_weather_for_cities(cities: Vec<WeatherCityInput>, days: u8) -> WeatherBatchResponse {
  let runtime = read_runtime_config_file();
  let config = read_runtime_config();
  let Some(key) = config.qq_map_key else {
    write_daily_log(&runtime, "weather", "missing qq_map_key");
    return WeatherBatchResponse {
      items: Vec::new(),
      updated_at: None,
      reason: Some("未配置腾讯定位 Key，无法请求天气".to_string()),
    };
  };

  let get_md = if days >= 7 { 1 } else { 0 };
  let client = reqwest::blocking::Client::new();
  let mut items = Vec::new();
  let mut updated_at = None;
  write_daily_log(
    &runtime,
    "weather",
    &format!("batch start count={} days={}", cities.len(), days),
  );

  for city in cities {
    if city.adcode.trim().is_empty() {
      write_daily_log(&runtime, "weather", &format!("skip city={} reason=empty_adcode", city.title));
      continue;
    }

    let endpoint = format!(
      "https://apis.map.qq.com/ws/weather/v1/?key={}&adcode={}&type=future&get_md={}",
      urlencoding::encode(&key),
      urlencoding::encode(&city.adcode),
      get_md
    );
    write_daily_log(
      &runtime,
      "weather",
      &format!("request city={} adcode={} endpoint={}", city.title, city.adcode, endpoint),
    );

    let mut payload_opt: Option<QqWeatherResponse> = None;
    for attempt in 1..=3 {
      let response = match client.get(&endpoint).send() {
        Ok(response) => response,
        Err(err) => {
          write_daily_log(
            &runtime,
            "weather",
            &format!("request city={} attempt={} error={}", city.title, attempt, err),
          );
          if attempt < 3 {
            sleep(Duration::from_millis(220 * attempt as u64));
            continue;
          }
          break;
        }
      };

      let status = response.status();
      let body = match response.text() {
        Ok(text) => text,
        Err(err) => {
          write_daily_log(
            &runtime,
            "weather",
            &format!("read body city={} attempt={} error={}", city.title, attempt, err),
          );
          if attempt < 3 {
            sleep(Duration::from_millis(220 * attempt as u64));
            continue;
          }
          break;
        }
      };

      let body_preview = body.chars().take(300).collect::<String>();
      write_daily_log(
        &runtime,
        "weather",
        &format!(
          "response city={} attempt={} status={} body_preview={}",
          city.title, status, attempt, body_preview
        ),
      );

      let payload: QqWeatherResponse = match serde_json::from_str(&body) {
        Ok(payload) => payload,
        Err(err) => {
          write_daily_log(
            &runtime,
            "weather",
            &format!("decode city={} attempt={} error={}", city.title, attempt, err),
          );
          if attempt < 3 {
            sleep(Duration::from_millis(220 * attempt as u64));
            continue;
          }
          break;
        }
      };

      if payload.status == 120 && attempt < 3 {
        write_daily_log(
          &runtime,
          "weather",
          &format!("rate limited city={} attempt={} retrying", city.title, attempt),
        );
        sleep(Duration::from_millis(350 * attempt as u64));
        continue;
      }

      payload_opt = Some(payload);
      break;
    }

    let Some(payload) = payload_opt else {
      continue;
    };

    if payload.status != 0 {
      write_daily_log(
        &runtime,
        "weather",
        &format!("api city={} status={} not_zero", city.title, payload.status),
      );
      continue;
    }

    let Some(result) = payload.result else {
      continue;
    };
    let Some(mut forecast_list) = result.forecast else {
      continue;
    };
    let Some(forecast) = forecast_list.pop() else {
      continue;
    };

    if updated_at.is_none() {
      updated_at = forecast.update_time.clone();
    }

    let mapped_days = forecast
      .infos
      .into_iter()
      .take(days as usize)
      .filter_map(|info| {
        let day_temp = info.day.temperature.as_ref().and_then(json_to_i64);
        let night_temp = info.night.temperature.as_ref().and_then(json_to_i64);
        let (temp_max, temp_min) = match (day_temp, night_temp) {
          (Some(day), Some(night)) => (day.max(night), day.min(night)),
          (Some(day), None) => (day, day),
          (None, Some(night)) => (night, night),
          (None, None) => return None,
        };

        let weather = info
          .day
          .weather
          .clone()
          .or(info.night.weather.clone())
          .unwrap_or_else(|| "未知".to_string());

        Some(WeatherDay {
          date: info.date,
          weather,
          temp_max,
          temp_min,
        })
      })
      .collect::<Vec<_>>();

    if mapped_days.is_empty() {
      write_daily_log(
        &runtime,
        "weather",
        &format!("skip city={} reason=empty_mapped_days", city.title),
      );
      continue;
    }

    write_daily_log(&runtime, "weather", &format!("ok city={}", city.title));

    items.push(WeatherCityResult {
      id: city.id,
      title: city.title,
      source: city.source,
      days: mapped_days,
    });

    // Keep per-key QPS in a safe range when one batch contains multiple cities.
    sleep(Duration::from_millis(160));
  }

  let reason = if items.is_empty() {
    Some("腾讯天气接口未返回有效数据，请检查 Key、配额或 adcode 是否有效".to_string())
  } else {
    None
  };

  WeatherBatchResponse {
    items,
    updated_at,
    reason,
  }
}

fn toggle_main_window(app: &tauri::AppHandle) {
  if let Some(window) = app.get_webview_window("main") {
    if window.is_visible().unwrap_or(false) {
      let _ = window.hide();
    } else {
      let _ = window.show();
      let _ = window.set_focus();
    }
  }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .invoke_handler(tauri::generate_handler![
      get_runtime_config,
      save_runtime_config,
      save_config_template_via_dialog,
      get_current_location,
      get_weather_for_cities
    ])
    .setup(|app| {
      let show_item = MenuItem::with_id(app, "toggle", "显示/隐藏", true, None::<&str>)?;
      let quit_item = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
      let tray_menu = Menu::with_items(app, &[&show_item, &quit_item])?;

      let mut tray = TrayIconBuilder::new().menu(&tray_menu);
      if let Some(icon) = app.default_window_icon().cloned() {
        tray = tray.icon(icon);
      }

      tray
        .tooltip("Duet Desktop Weather")
        .on_menu_event(|app, event| match event.id.as_ref() {
          "toggle" => {
            toggle_main_window(app);
          }
          "quit" => {
            app.exit(0);
          }
          _ => {}
        })
        .on_tray_icon_event(|tray, event| {
          if let TrayIconEvent::Click {
            button: MouseButton::Left,
            button_state: MouseButtonState::Up,
            ..
          } = event
          {
            let app = tray.app_handle();
            toggle_main_window(&app);
          }
        })
        .build(app)?;

      if !cfg!(debug_assertions) {
        if let Some(window) = app.get_webview_window("main") {
          let _ = window.set_skip_taskbar(true);
        }
      }

      #[cfg(debug_assertions)]
      {
        if let Some(window) = app.get_webview_window("main") {
          let _ = window.open_devtools();
        }
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
