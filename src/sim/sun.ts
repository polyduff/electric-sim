import type { SimConfig } from '../shared/types';

/**
 * Solar geometry for the site. The config carries latitude and day of year;
 * longitude and the clock offset are fixed for Christchurch in NZDT.
 */
export const SITE_LONGITUDE_DEG = 172.6;
/** Local clock = UTC + 13 h (New Zealand Daylight Time, in force on 12 November). */
export const UTC_OFFSET_H = 13;
/** Array tilt from horizontal, facing due north (the sunny side at -43.5 latitude). */
export const PANEL_TILT_DEG = 25;
/** DC-to-AC performance ratio (temperature, soiling, inverter). */
export const PV_PERFORMANCE_RATIO = 0.86;

const DEG = Math.PI / 180;

interface SunVector {
  /** Unit vector towards the sun in local east / north / up coordinates. */
  east: number;
  north: number;
  up: number;
}

/** Sun direction at `timeH` hours after scenario start (continuous in timeH). */
function sunVector(config: SimConfig, timeH: number): SunVector {
  const clock = config.startHour + timeH; // local clock hours since midnight of day 0
  // Continuous day number, equal to dayOfYear at local noon of the first day.
  const dayNumber = config.dayOfYear + (clock - 12) / 24;
  const gamma = (2 * Math.PI * (dayNumber - 1)) / 365;
  // Spencer (1971) Fourier fits: declination (rad) and equation of time (minutes).
  const decl =
    0.006918 -
    0.399912 * Math.cos(gamma) +
    0.070257 * Math.sin(gamma) -
    0.006758 * Math.cos(2 * gamma) +
    0.000907 * Math.sin(2 * gamma) -
    0.002697 * Math.cos(3 * gamma) +
    0.00148 * Math.sin(3 * gamma);
  const eotMin =
    229.18 *
    (0.000075 +
      0.001868 * Math.cos(gamma) -
      0.032077 * Math.sin(gamma) -
      0.014615 * Math.cos(2 * gamma) -
      0.040849 * Math.sin(2 * gamma));
  const solarTime = clock + (SITE_LONGITUDE_DEG - 15 * UTC_OFFSET_H) / 15 + eotMin / 60;
  const hourAngle = 15 * (solarTime - 12) * DEG;
  const lat = config.latitudeDeg * DEG;
  const cd = Math.cos(decl);
  const sd = Math.sin(decl);
  return {
    east: -cd * Math.sin(hourAngle),
    north: sd * Math.cos(lat) - cd * Math.sin(lat) * Math.cos(hourAngle),
    up: sd * Math.sin(lat) + cd * Math.cos(lat) * Math.cos(hourAngle),
  };
}

/**
 * Sun elevation above the horizon and azimuth clockwise from north, in degrees,
 * at `timeH` hours since scenario start (fractional). At Christchurch the midday
 * sun is in the north, so the azimuth passes through 0/360 around solar noon
 * (about 13:14 NZDT on 12 November).
 */
export function sunPosition(
  config: SimConfig,
  timeH: number,
): { elevationDeg: number; azimuthDeg: number } {
  const v = sunVector(config, timeH);
  const elevationDeg = Math.asin(Math.max(-1, Math.min(1, v.up))) / DEG;
  let azimuthDeg = Math.atan2(v.east, v.north) / DEG;
  if (azimuthDeg < 0) azimuthDeg += 360;
  return { elevationDeg, azimuthDeg };
}

/** Clear-sky AC output (kW) of the tilted north-facing array at an instant. */
export function clearSkyPowerKw(config: SimConfig, timeH: number): number {
  const v = sunVector(config, timeH);
  if (v.up <= 0) return 0;
  const elevDeg = Math.asin(Math.min(1, v.up)) / DEG;
  // Kasten-Young air mass, Meinel clear-sky beam irradiance.
  const airMass = 1 / (v.up + 0.50572 * Math.pow(elevDeg + 6.07995, -1.6364));
  const dni = 1353 * Math.pow(0.7, Math.pow(airMass, 0.678));
  const dhi = 0.11 * dni * Math.min(1, v.up * 4); // diffuse fades out at the horizon
  const ghi = dni * v.up + dhi;
  const tilt = PANEL_TILT_DEG * DEG;
  const cosInc = v.north * Math.sin(tilt) + v.up * Math.cos(tilt);
  const poa =
    dni * Math.max(0, cosInc) +
    (dhi * (1 + Math.cos(tilt))) / 2 +
    (0.2 * ghi * (1 - Math.cos(tilt))) / 2;
  return (config.pvKwp * PV_PERFORMANCE_RATIO * poa) / 1000;
}

/** Average clear-sky output over [timeH, timeH + dtH), by midpoint sampling. */
export function clearSkyStepKw(config: SimConfig, timeH: number, dtH: number): number {
  const SAMPLES = 6;
  let sum = 0;
  for (let i = 0; i < SAMPLES; i++) sum += clearSkyPowerKw(config, timeH + ((i + 0.5) / SAMPLES) * dtH);
  return sum / SAMPLES;
}
