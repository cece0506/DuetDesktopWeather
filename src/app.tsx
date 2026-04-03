import { invoke } from "@tauri-apps/api/core";
import { LogicalSize } from "@tauri-apps/api/dpi";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { CASCADE_DATA } from "./data/china-cascade.generated";
import "./app.css";

type RangeDays = 1 | 3 | 7;

type OneDayLayout = "row" | "column";

type SizePreset = "small" | "medium" | "large" | "custom";

type WidgetSettings = {
  pinned: boolean;
  opacity: number;
  fontScale: number;
  fontColor: string;
  sizePreset: SizePreset;
  customItemWidth: number;
  oneDayLayout: OneDayLayout;
};

type LocationLookupResponse = {
  city: City | null;
  reason?: string | null;
};

type WeatherBatchResponse = {
  items: Array<{
    id: string;
    title: string;
    source: "location" | "manual";
    days: WeatherDay[];
  }>;
  updated_at?: string | null;
  reason?: string | null;
};

type City = {
  id: string;
  title: string;
  adcode: string;
  latitude: number;
  longitude: number;
  source: "location" | "manual";
};

type WeatherDay = {
  date: string;
  weather: string;
  tempMax: number;
  tempMin: number;
};

type CityWeather = {
  days: WeatherDay[];
};

type PersistedState = {
  rangeDays: RangeDays;
  settings: WidgetSettings;
  manualCities: City[];
  selectedProvinceCode: string;
  selectedCityCode: string;
  selectedDistrictCode: string;
  settingsDialogPosition: {
    left: number;
    top: number;
  };
};

const REFRESH_MS = 2 * 60 * 60 * 1000;
const STORAGE_KEY = "desktop-weather-settings-v4";

const DEFAULT_SETTINGS: WidgetSettings = {
  pinned: false,
  opacity: 0.26,
  fontScale: 14,
  fontColor: "#f4fbff",
  sizePreset: "medium",
  customItemWidth: 112,
  oneDayLayout: "row",
};

function weatherVisual(weather: string) {
  if (weather.includes("晴")) return { emoji: "☀️", label: weather };
  if (weather.includes("多云")) return { emoji: "🌤️", label: weather };
  if (weather.includes("阴")) return { emoji: "☁️", label: weather };
  if (weather.includes("雾") || weather.includes("霾")) return { emoji: "🌫️", label: weather };
  if (weather.includes("雷")) return { emoji: "⛈️", label: weather };
  if (weather.includes("雪")) return { emoji: "❄️", label: weather };
  if (weather.includes("雨")) return { emoji: "🌧️", label: weather };
  if (weather.includes("风")) return { emoji: "💨", label: weather };
  return { emoji: "🌈", label: weather || "多变" };
}

function findFirstDistrictForCityCode(cityCode: string) {
  for (const province of CASCADE_DATA) {
    for (const city of province.cities) {
      if (city.code === cityCode && city.districts.length > 0) {
        return { province, city, district: city.districts[0] };
      }
    }
  }
  return null;
}

function findDistrictPathByAdcode(adcode: string) {
  for (const province of CASCADE_DATA) {
    for (const city of province.cities) {
      const district = city.districts.find((item) => item.code === adcode);
      if (district) {
        return { province, city, district };
      }
    }
  }
  return null;
}

function normalizeManualCity(city: City): City {
  if (city.adcode && city.adcode.length === 6) {
    return city;
  }

  const byCityCode = city.adcode ? findFirstDistrictForCityCode(city.adcode) : null;
  if (byCityCode) {
    return {
      ...city,
      id: byCityCode.district.code,
      adcode: byCityCode.district.code,
      title: `${byCityCode.province.name}${byCityCode.city.name}${byCityCode.district.name}`,
    };
  }

  const byTitle = CASCADE_DATA.flatMap((province) =>
    province.cities.map((cityNode) => ({ province, cityNode })),
  ).find(({ province, cityNode }) => city.title.startsWith(`${province.name}${cityNode.name}`));

  if (byTitle && byTitle.cityNode.districts.length > 0) {
    const district = byTitle.cityNode.districts[0];
    return {
      ...city,
      id: district.code,
      adcode: district.code,
      title: `${byTitle.province.name}${byTitle.cityNode.name}${district.name}`,
    };
  }

  return city;
}

function loadPersistedState(): PersistedState | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PersistedState;
    parsed.manualCities = (parsed.manualCities || []).map((city) => normalizeManualCity(city as City));

    if (!parsed.selectedProvinceCode) {
      parsed.selectedProvinceCode = CASCADE_DATA[0]?.code || "";
    }
    return parsed;
  } catch {
    return null;
  }
}

function sizePresetToItemWidth(settings: WidgetSettings) {
  if (settings.sizePreset === "small") return 94;
  if (settings.sizePreset === "medium") return 112;
  if (settings.sizePreset === "large") return 132;
  return settings.customItemWidth;
}

function formatTime(date: Date) {
  const p = (n: number) => n.toString().padStart(2, "0");
  return `${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`;
}

function formatServerRefreshTime(value?: string | null) {
  if (!value) return formatTime(new Date());

  const input = value.trim();
  if (!input) return formatTime(new Date());
  if (/^\d{4}-\d{2}-\d{2}\s\d{2}:\d{2}$/.test(input)) return `${input}:00`;
  if (/^\d{2}:\d{2}$/.test(input)) return `${input}:00`;
  if (/^\d{2}:\d{2}:\d{2}$/.test(input)) return input;

  const parsed = new Date(input.replace(" ", "T"));
  if (!Number.isNaN(parsed.getTime())) {
    const y = parsed.getFullYear();
    const m = (parsed.getMonth() + 1).toString().padStart(2, "0");
    const d = parsed.getDate().toString().padStart(2, "0");
    return `${y}-${m}-${d} ${formatTime(parsed)}`;
  }

  return input;
}

export function App() {
  const persisted = loadPersistedState();
  const isDev = import.meta.env.DEV;
  const currentWindow = useMemo(() => getCurrentWindow(), []);

  const [rangeDays, setRangeDays] = useState<RangeDays>(
    persisted?.rangeDays || 1,
  );
  const [settings, setSettings] = useState<WidgetSettings>(
    persisted?.settings || DEFAULT_SETTINGS,
  );
  const [manualCities, setManualCities] = useState<City[]>(
    persisted?.manualCities || [],
  );

  const [locationCity, setLocationCity] = useState<City | null>(null);
  const [weatherMap, setWeatherMap] = useState<Record<string, CityWeather>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [locationReason, setLocationReason] = useState("");
  const [lastRefreshTime, setLastRefreshTime] = useState("");
  const [syncStatus, setSyncStatus] = useState<"" | "syncing" | "done">("");
  const syncTimerRef = useRef<number | null>(null);
  const weatherLoadingRef = useRef(false);
  const pendingCitiesRef = useRef<City[] | null>(null);

  const [selectedProvinceCode, setSelectedProvinceCode] = useState(
    persisted?.selectedProvinceCode || CASCADE_DATA[0]?.code || "",
  );
  const [selectedCityCode, setSelectedCityCode] = useState(
    persisted?.selectedCityCode || "",
  );
  const [selectedDistrictCode, setSelectedDistrictCode] = useState(
    persisted?.selectedDistrictCode || "",
  );
  const [addingCity, setAddingCity] = useState(false);

  const [hovering, setHovering] = useState(false);
  const repinTimerRef = useRef<number | null>(null);
  const widgetRef = useRef<HTMLElement | null>(null);
  const fitRafRef = useRef<number | null>(null);
  const [overflowY, setOverflowY] = useState(false);

  const [showSettingsDialog, setShowSettingsDialog] = useState(false);
  const [settingsDialogPosition, setSettingsDialogPosition] = useState(
    persisted?.settingsDialogPosition || { left: 36, top: 36 },
  );
  const [regionPickerForCityId, setRegionPickerForCityId] = useState<string | null>(null);
  const [regionPickerDistrictCode, setRegionPickerDistrictCode] = useState("");
  const [configBusy, setConfigBusy] = useState(false);
  const [configTip, setConfigTip] = useState("");
  const configFileInputRef = useRef<HTMLInputElement | null>(null);
  const configTipTimerRef = useRef<number | null>(null);
  const dialogDraggingRef = useRef<{
    x: number;
    y: number;
    left: number;
    top: number;
  } | null>(null);

  const pinned = settings.pinned;

  const cities = useMemo(() => {
    if (!locationCity) return [...manualCities];
    return [locationCity, ...manualCities];
  }, [locationCity, manualCities]);

  const selectedProvince = useMemo(
    () => CASCADE_DATA.find((province) => province.code === selectedProvinceCode) || null,
    [selectedProvinceCode],
  );
  const cityOptions = selectedProvince?.cities || [];
  const selectedCity =
    cityOptions.find((item) => item.code === selectedCityCode) || null;
  const districtOptions = selectedCity?.districts || [];

  useEffect(() => {
    if (!selectedProvinceCode && CASCADE_DATA.length > 0) {
      setSelectedProvinceCode(CASCADE_DATA[0].code);
      return;
    }

    if (selectedProvince && !cityOptions.some((item) => item.code === selectedCityCode)) {
      setSelectedCityCode(cityOptions[0]?.code || "");
      return;
    }

    if (selectedCity && !districtOptions.some((item) => item.code === selectedDistrictCode)) {
      setSelectedDistrictCode(districtOptions[0]?.code || "");
    }
  }, [
    cityOptions,
    districtOptions,
    selectedCity,
    selectedCityCode,
    selectedDistrictCode,
    selectedProvince,
    selectedProvinceCode,
  ]);

  const clearRepinTimer = () => {
    if (repinTimerRef.current) {
      window.clearTimeout(repinTimerRef.current);
      repinTimerRef.current = null;
    }
  };

  const showSyncDone = () => {
    if (syncTimerRef.current) {
      window.clearTimeout(syncTimerRef.current);
    }
    setSyncStatus("done");
    syncTimerRef.current = window.setTimeout(() => {
      setSyncStatus("");
    }, 1800);
  };

  const showConfigTip = (message: string, delayMs = 3000) => {
    if (configTipTimerRef.current) {
      window.clearTimeout(configTipTimerRef.current);
      configTipTimerRef.current = null;
    }

    setConfigTip(message);
    configTipTimerRef.current = window.setTimeout(() => {
      setConfigTip("");
      configTipTimerRef.current = null;
    }, delayMs);
  };

  const updateSettings = (patch: Partial<WidgetSettings>) => {
    setSettings((prev) => ({ ...prev, ...patch }));
  };

  const handleDragWindow = async () => {
    if (pinned) return;
    try {
      await currentWindow.startDragging();
    } catch (err) {
      // Ignore drag errors.
    }
  };

  const requestFitWindow = () => {
    if (fitRafRef.current) {
      window.cancelAnimationFrame(fitRafRef.current);
    }

    fitRafRef.current = window.requestAnimationFrame(async () => {
      const node = widgetRef.current;
      if (!node) return;

      const rect = node.getBoundingClientRect();
      const contentWidth = Math.max(Math.ceil(rect.width), Math.ceil(node.scrollWidth));
      const contentHeight = Math.max(Math.ceil(rect.height), Math.ceil(node.scrollHeight));

      const desiredWidth = Math.max(120, contentWidth + 2);
      const desiredHeight = Math.max(80, contentHeight + 2);
      const maxHeight = Math.max(220, window.innerHeight - 8);
      const finalHeight = Math.max(desiredHeight, maxHeight);

      setOverflowY(desiredHeight > maxHeight);

      try {
        await currentWindow.setSize(new LogicalSize(desiredWidth, finalHeight));
      } catch (err){
        // Ignore platform-specific resize errors.
      }
    });
  };

  const loadAllWeather = async (targetCities: City[]) => {
    if (weatherLoadingRef.current) {
      pendingCitiesRef.current = [...targetCities];
      return false;
    }

    if (targetCities.length === 0) {
      setLoading(false);
      return true;
    }

    weatherLoadingRef.current = true;

    const hasData = Object.keys(weatherMap).length > 0;
    if (!hasData) {
      setLoading(true);
    } else {
      setSyncStatus("syncing");
    }
    setError("");
    try {
      const nextMap: Record<string, CityWeather> = {};
      const response = await invoke<WeatherBatchResponse>("get_weather_for_cities", {
        cities: targetCities.map((city) => ({
          id: city.id,
          title: city.title,
          adcode: city.adcode,
          source: city.source,
        })),
        days: rangeDays,
      });

      response.items.forEach((item) => {
        nextMap[item.id] = {
          days: item.days.map((day) => ({
            date: day.date,
            weather: day.weather,
            tempMax: day.tempMax,
            tempMin: day.tempMin,
          })),
        };
      });

      if (Object.keys(nextMap).length === 0) {
        throw new Error(response.reason || "所有城市数据获取失败");
      }
      setWeatherMap(nextMap);
      setLastRefreshTime(formatServerRefreshTime(response.updated_at));
      if (hasData) {
        showSyncDone();
      }
      return true;
    } catch (err){
      const message = err instanceof Error ? err.message : "天气数据获取失败，请稍后重试";
      setError(message);
      setSyncStatus("");
      return false;
    } finally {
      weatherLoadingRef.current = false;
      if (!hasData) {
        setLoading(false);
      }

      if (pendingCitiesRef.current) {
        const nextCities = pendingCitiesRef.current;
        pendingCitiesRef.current = null;
        void loadAllWeather(nextCities);
      }
    }
  };

  const addCity = async () => {
    if (addingCity) return;

    setAddingCity(true);
    setSyncStatus("syncing");
    setError("");
    try {
      if (!selectedProvince || !selectedCity || !selectedDistrictCode) {
        throw new Error("请选择完整的省市区");
      }

      const district = districtOptions.find((item) => item.code === selectedDistrictCode);
      if (!district) {
        throw new Error("未找到匹配区县");
      }

      const title = `${selectedProvince.name}${selectedCity.name}${district.name}`;
      const city: City = {
        id: district.code,
        title,
        adcode: district.code,
        latitude: 0,
        longitude: 0,
        source: "manual",
      };

      setManualCities((prev) => {
        if (prev.some((c) => c.adcode === city.adcode))
          return prev;
        return [...prev, city];
      });
      showSyncDone();
    } catch {
      setError("添加城市失败，请稍后再试");
      setSyncStatus("");
    } finally {
      setAddingCity(false);
    }
  };

  const removeCity = (id: string) => {
    setSyncStatus("syncing");
    setManualCities((prev) => prev.filter((city) => city.id !== id));
    showSyncDone();
  };

  const openRegionPicker = (city: City) => {
    const path = findDistrictPathByAdcode(city.adcode);
    if (!path || path.city.districts.length <= 1) {
      return;
    }
    setRegionPickerForCityId(city.id);
    setRegionPickerDistrictCode(city.adcode);
  };

  const applyRegionSwitch = () => {
    if (!regionPickerForCityId || !regionPickerDistrictCode) {
      setRegionPickerForCityId(null);
      return;
    }

    setSyncStatus("syncing");
    setManualCities((prev) => {
      const current = prev.find(
        (city) => city.id === regionPickerForCityId && city.source === "manual",
      );
      if (!current) {
        return prev;
      }

      const currentPath = findDistrictPathByAdcode(current.adcode);
      if (!currentPath || currentPath.city.districts.length <= 1) {
        return prev;
      }

      const targetDistrict = currentPath.city.districts.find(
        (item) => item.code === regionPickerDistrictCode,
      );
      if (!targetDistrict || targetDistrict.code === current.adcode) {
        return prev;
      }

      if (prev.some((item) => item.id !== current.id && item.adcode === targetDistrict.code)) {
        setError("该区域已添加，请选择同城市下其它区域");
        return prev;
      }

      return prev.map((city) => {
        if (city.id !== current.id) return city;
        return {
          ...city,
          id: targetDistrict.code,
          adcode: targetDistrict.code,
          title: `${currentPath.province.name}${currentPath.city.name}${targetDistrict.name}`,
        };
      });
    });
    setRegionPickerForCityId(null);
    setRegionPickerDistrictCode("");
    showSyncDone();
  };

  const handleDownloadConfigTemplate = () => {
    setConfigBusy(true);
    setError("");
    showConfigTip("模板下载开始，请选择保存位置...", 2600);

    invoke<string>("save_config_template_via_dialog")
      .then((message) => {
        showConfigTip(message, 5000);
      })
      .catch((err) => {
        const text = String(err || "");
        if (!text.includes("已取消")) {
          setError(text || "模板下载失败，请重试");
        }
      })
      .finally(() => {
        setConfigBusy(false);
      });
  };

  const refreshWithLatestConfig = async () => {
    const result = await invoke<LocationLookupResponse>("get_current_location");
    setLocationCity(result.city);
    setLocationReason(result.reason || "");

    const merged = result.city ? [result.city, ...manualCities] : [...manualCities];
    const weatherOk = await loadAllWeather(merged);
    return {
      weatherOk,
      locationReason: result.reason || "",
    };
  };

  const handleImportConfigFile = async (event: Event) => {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;

    setConfigBusy(true);
    setError("");
    try {
      const text = await file.text();
      await invoke<string>("save_runtime_config", { rawJson: text });
      const check = await refreshWithLatestConfig();

      if (!check.weatherOk || check.locationReason.includes("异常") || check.locationReason.includes("失败")) {
        setError("配置已导入，但 Key 可能无效、配额不足或网络异常，请检查后重试");
        showConfigTip("配置导入失败，请检查 Key 与配额", 3000);
      } else {
        setError("");
        showConfigTip("配置导入成功，已应用", 3000);
      }
    } catch (err) {
      console.error("导入配置失败", err);
      setError("导入配置失败，请检查 JSON 格式和字段");
    } finally {
      setConfigBusy(false);
      input.value = "";
    }
  };

  useEffect(() => {
    (async () => {
      const result = await invoke<LocationLookupResponse>("get_current_location");
      setLocationCity(result.city);
      setLocationReason(result.reason || "");
    })();

    return () => {
      clearRepinTimer();
      if (syncTimerRef.current) {
        window.clearTimeout(syncTimerRef.current);
      }
      if (fitRafRef.current) {
        window.cancelAnimationFrame(fitRafRef.current);
      }
      if (configTipTimerRef.current) {
        window.clearTimeout(configTipTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    const state: PersistedState = {
      rangeDays,
      settings,
      manualCities,
      selectedProvinceCode,
      selectedCityCode,
      selectedDistrictCode,
      settingsDialogPosition,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }, [
    manualCities,
    rangeDays,
    selectedCityCode,
    selectedDistrictCode,
    selectedProvinceCode,
    settings,
    settingsDialogPosition,
  ]);

  useEffect(() => {
    void loadAllWeather(cities);
    const timer = window.setInterval(() => {
      void loadAllWeather(cities);
    }, REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [cities, rangeDays]);

  useEffect(() => {
    const applyWindowState = async () => {
      try {
        await currentWindow.setAlwaysOnBottom(pinned);
        await currentWindow.setResizable(false);
        await currentWindow.setMaximizable(false);
        await currentWindow.setMinimizable(!pinned);
        await currentWindow.setSkipTaskbar(!isDev);
      } catch {
        // Ignore platform-specific window API failures.
      }
    };
    applyWindowState();
  }, [currentWindow, isDev, pinned]);

  useEffect(() => {
    const onMouseMove = (event: MouseEvent) => {
      const dragging = dialogDraggingRef.current;
      if (!dragging) return;

      setSettingsDialogPosition({
        left: dragging.left + event.clientX - dragging.x,
        top: dragging.top + event.clientY - dragging.y,
      });
    };

    const onMouseUp = () => {
      dialogDraggingRef.current = null;
    };

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, []);

  useEffect(() => {
    if (!widgetRef.current) return;

    const observer = new ResizeObserver(() => {
      requestFitWindow();
    });
    observer.observe(widgetRef.current);
    requestFitWindow();

    return () => {
      observer.disconnect();
    };
  }, [widgetRef.current]);

  useEffect(() => {
    requestFitWindow();
  }, [
    addingCity,
    cities.length,
    overflowY,
    pinned,
    rangeDays,
    selectedCityCode,
    selectedDistrictCode,
    selectedProvinceCode,
    settings,
    showSettingsDialog,
  ]);

  const onMouseEnter = () => {
    setHovering(true);
    clearRepinTimer();
  };

  const onMouseLeave = () => {
    setHovering(false);
    clearRepinTimer();
    if (!pinned) {
      // repinTimerRef.current = window.setTimeout(() => {
      //   updateSettings({ pinned: true });
      // }, 10000);
    }
  };

  const beginDialogDrag = (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    dialogDraggingRef.current = {
      x: event.clientX,
      y: event.clientY,
      left: settingsDialogPosition.left,
      top: settingsDialogPosition.top,
    };
  };

  const daysClass =
    rangeDays === 1 && settings.oneDayLayout === "column"
      ? "forecast-row column"
      : "forecast-row";
  const itemWidth = sizePresetToItemWidth(settings);

  return (
    <main
      class={pinned ? "widget-shell pinned-shell" : "widget-shell"}
      style={{
        "--widget-opacity": String(settings.opacity),
        "--font-size": `${settings.fontScale}px`,
        "--font-color": settings.fontColor,
        "--forecast-item-width": `${itemWidth}px`,
      }}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <section ref={widgetRef} class={pinned ? "widget pinned" : "widget"}>
        {(hovering || !pinned) && (
          <button
            class={pinned ? "pin-btn icon-btn inside-right" : "pin-btn icon-btn"}
            title={pinned ? "解除固定（可拖动）" : "固定到桌面"}
            onClick={() => {
              updateSettings({ pinned: !pinned });
              setShowSettingsDialog(false);
            }}
          >
            {pinned ? "🔓" : "📌"}
          </button>
        )}

        {!pinned && (
          <div
            class="drag-bar"
            onMouseDown={() => handleDragWindow()}
            title="按住拖动窗口"
          >
            <span>⋮⋮</span>
            <span>按住拖动窗口</span>
          </div>
        )}

        {!pinned && (
          <header class="widget-header">
            <div>
              <h1>DUET 天气小挂件</h1>
              <p class="subtitle">
                腾讯天气 · 每2小时自动刷新 · 服务器刷新时间：
                {lastRefreshTime || "--:--:--"}
              </p>
              {configTip && <p class="subtitle config-tip-text">{configTip}</p>}
            </div>
            <button
              class="open-settings-btn"
              onClick={() => setShowSettingsDialog((v) => !v)}
            >
              ⚙️ 自定义
            </button>
          </header>
        )}

        {!pinned && (
          <div class="toolbar">
            <div class="range-tabs" role="tablist" aria-label="查询天数">
              {[1, 3, 7].map((d) => (
                <button
                  key={d}
                  class={rangeDays === d ? "tab active" : "tab"}
                  onClick={() => setRangeDays(d as RangeDays)}
                >
                  {d === 1 ? "当前" : `${d}天`}
                </button>
              ))}
            </div>

            {rangeDays === 1 && (
              <div class="range-tabs" role="tablist" aria-label="当天布局">
                <button
                  class={settings.oneDayLayout === "row" ? "tab active" : "tab"}
                  onClick={() => updateSettings({ oneDayLayout: "row" })}
                >
                  展示一行
                </button>
                <button
                  class={
                    settings.oneDayLayout === "column" ? "tab active" : "tab"
                  }
                  onClick={() => updateSettings({ oneDayLayout: "column" })}
                >
                  展示一列
                </button>
              </div>
            )}

            <div class="cascade-filter">
              <div class="cascade-row">
                <select
                  value={selectedProvinceCode}
                  onChange={(e) =>
                    setSelectedProvinceCode(
                      (e.currentTarget as HTMLSelectElement).value,
                    )
                  }
                >
                  {CASCADE_DATA.map((province) => (
                    <option key={province.code} value={province.code}>
                      {province.name}
                    </option>
                  ))}
                </select>

                <select
                  value={selectedCityCode}
                  onChange={(e) =>
                    setSelectedCityCode(
                      (e.currentTarget as HTMLSelectElement).value,
                    )
                  }
                >
                  {cityOptions.map((city) => (
                    <option key={city.code} value={city.code}>
                      {city.name}
                    </option>
                  ))}
                </select>

                <select
                  value={selectedDistrictCode}
                  onChange={(e) =>
                    setSelectedDistrictCode(
                      (e.currentTarget as HTMLSelectElement).value,
                    )
                  }
                >
                  {districtOptions.map((district) => (
                    <option key={district.code} value={district.code}>
                      {district.name}
                    </option>
                  ))}
                </select>

                <button disabled={addingCity} onClick={() => addCity()}>
                  添加
                </button>
              </div>

              <div
                class={
                  syncStatus === "syncing"
                    ? "sync-tip syncing"
                    : syncStatus === "done"
                      ? "sync-tip done"
                      : "sync-tip"
                }
              >
                {syncStatus === "syncing"
                  ? "同步中"
                  : syncStatus === "done"
                    ? "同步完成"
                    : ""}
              </div>
            </div>
          </div>
        )}

        {!pinned && locationReason && <div class="error">{locationReason}</div>}
        {!pinned && error && <div class="error">{error}</div>}

        {loading && Object.keys(weatherMap).length === 0 ? (
          <div class="loading">正在同步天气...</div>
        ) : (
          <div
            class={`city-list ${overflowY ? "overflow" : ""} ${rangeDays === 1 && settings.oneDayLayout === "row" ? "row" : rangeDays === 1 && settings.oneDayLayout === "column" ? "column" : ""}`}
          >
            {cities.map((city) => {
              const weather = weatherMap[city.id];
              const days = (weather?.days || []).slice(0, rangeDays);
              const displayTitle = city.source === "location"
                ? `📍 ${city.title.replace(/^当前位置-/, "")}`
                : city.title;

              return (
                <article class="city-card" key={city.id}>
                  <div class="city-card-header">
                    <h2>{displayTitle}</h2>
                    {!pinned && city.source === "manual" && (
                      <div class="city-actions">
                        <button
                          class="remove-btn icon-delete"
                          title="切换区域"
                          onClick={() => openRegionPicker(city)}
                        >
                          🔁
                        </button>
                        <button
                          class="remove-btn icon-delete"
                          title="删除"
                          onClick={() => removeCity(city.id)}
                        >
                          🗑
                        </button>
                      </div>
                    )}
                  </div>

                  {!pinned && city.source === "manual" && regionPickerForCityId === city.id && (() => {
                    const path = findDistrictPathByAdcode(city.adcode);
                    if (!path || path.city.districts.length <= 1) {
                      return null;
                    }
                    return (
                      <div class="region-picker">
                        <select
                          value={regionPickerDistrictCode}
                          onChange={(e) =>
                            setRegionPickerDistrictCode(
                              (e.currentTarget as HTMLSelectElement).value,
                            )
                          }
                        >
                          {path.city.districts.map((district) => (
                            <option key={district.code} value={district.code}>
                              {district.name}
                            </option>
                          ))}
                        </select>
                        <button
                          class="tab"
                          onClick={() => applyRegionSwitch()}
                        >
                          确定
                        </button>
                        <button
                          class="tab"
                          onClick={() => {
                            setRegionPickerForCityId(null);
                            setRegionPickerDistrictCode("");
                          }}
                        >
                          取消
                        </button>
                      </div>
                    );
                  })()}

                  <div class={daysClass}>
                    {days.map((day) => {
                      const visual = weatherVisual(day.weather);
                      const dateLabel = day.date.slice(5).replace("-", "/");
                      return (
                        <div class="forecast-item" key={day.date}>
                          <div class="date">{dateLabel}</div>
                          <div class="emoji">{visual.emoji}</div>
                          <div class="meta">
                            <div class="label">{visual.label}</div>
                            <div class="temp">
                              {Math.round(day.tempMin)}° ~{" "}
                              {Math.round(day.tempMax)}°
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>

      {showSettingsDialog && !pinned && (
        <section
          class="settings-dialog"
          style={{
            left: `${settingsDialogPosition.left}px`,
            top: `${settingsDialogPosition.top}px`,
          }}
        >
          <header
            class="settings-dialog-header"
            onMouseDown={(e) => beginDialogDrag(e as MouseEvent)}
          >
            <strong>自定义设置</strong>
            <button
              class="close-btn"
              onClick={() => setShowSettingsDialog(false)}
            >
              ✕
            </button>
          </header>
          <div class="settings-dialog-body">
            <label>
              透明度
              <input
                type="range"
                min="0.1"
                max="0.95"
                step="0.01"
                value={settings.opacity}
                onInput={(e) =>
                  updateSettings({
                    opacity: Number(
                      (e.currentTarget as HTMLInputElement).value,
                    ),
                  })
                }
              />
            </label>
            {/* <label>
              字体大小
              <input
                type="range"
                min="12"
                max="24"
                step="1"
                value={settings.fontScale}
                onInput={(e) =>
                  updateSettings({
                    fontScale: Number(
                      (e.currentTarget as HTMLInputElement).value,
                    ),
                  })
                }
              />
            </label> */}
            <label>
              字体颜色
              <input
                type="color"
                value={settings.fontColor}
                onInput={(e) =>
                  updateSettings({
                    fontColor: (e.currentTarget as HTMLInputElement).value,
                  })
                }
              />
            </label>
            <div class="config-actions">
              <button
                class="tab"
                disabled={configBusy}
                onClick={() => configFileInputRef.current?.click()}
              >
                导入配置
              </button>
              <button
                class="tab"
                disabled={configBusy}
                onClick={handleDownloadConfigTemplate}
              >
                下载模板
              </button>
              <input
                ref={configFileInputRef}
                class="hidden-file-input"
                type="file"
                accept="application/json,.json"
                onChange={(e) => void handleImportConfigFile(e)}
              />
            </div>
            {/* <label>
              尺寸预设
              <select
                value={settings.sizePreset}
                onChange={(e) =>
                  updateSettings({
                    sizePreset: (e.currentTarget as HTMLSelectElement)
                      .value as SizePreset,
                  })
                }
              >
                <option value="small">小</option>
                <option value="medium">中</option>
                <option value="large">大</option>
                <option value="custom">自定义</option>
              </select>
            </label> */}
            {settings.sizePreset === "custom" && (
              <label>
                自定义卡片宽度
                <input
                  type="range"
                  min="84"
                  max="180"
                  step="1"
                  value={settings.customItemWidth}
                  onInput={(e) =>
                    updateSettings({
                      customItemWidth: Number(
                        (e.currentTarget as HTMLInputElement).value,
                      ),
                    })
                  }
                />
              </label>
            )}
          </div>
        </section>
      )}
    </main>
  );
}
