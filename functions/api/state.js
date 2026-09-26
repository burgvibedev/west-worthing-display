// functions/api/state.js

export async function onRequest(context) {
  const { env } = context;

  // 1. Fetch Coastal Weather & Air Quality from Open-Meteo (No key needed)
  const weatherPromise = fetch(
    "https://api.open-meteo.com/v1/forecast?latitude=50.822&longitude=-0.384&current=temperature_2m,apparent_temperature,precipitation,wind_speed_10m,wind_direction_10m&wind_speed_unit=mph"
  ).then(r => r.json()).catch(() => null);

  const aqiPromise = fetch(
    "https://air-quality-api.open-meteo.com/v1/air-quality?latitude=50.822&longitude=-0.384&current=european_aqi"
  ).then(r => r.json()).catch(() => null);

  // 2. Fetch Live Darwin Train Arrivals/Departures for West Worthing (WWO)
  // Using open Huxley 2 proxy or Darwin token from Cloudflare env
  const trainPromise = fetch(
    "https://huxley2.azurewebsites.net/departures/WWO/5"
  ).then(r => r.json()).catch(() => null);

  // 3. Optional: Live TomTom Traffic on South Street
  let trafficPromise = Promise.resolve(null);
  if (env.TOMTOM_API_KEY) {
    trafficPromise = fetch(
      `https://api.tomtom.com/traffic/services/4/flowSegmentData/relative0/10/json?point=50.82255,-0.38386&unit=mph&key=${env.TOMTOM_API_KEY}`
    ).then(r => r.json()).catch(() => null);
  }

  const [weatherData, aqiData, trainData, trafficData] = await Promise.all([
    weatherPromise,
    aqiPromise,
    trainPromise,
    trafficPromise
  ]);

  // Process Telemetry
  const weather = weatherData?.current ? {
    temp: Math.round(weatherData.current.temperature_2m),
    feelsLike: Math.round(weatherData.current.apparent_temperature),
    windMph: Math.round(weatherData.current.wind_speed_10m),
    windDirectionDeg: weatherData.current.wind_direction_10m,
    rainMm: weatherData.current.precipitation
  } : { temp: 14, feelsLike: 12, windMph: 15, windDirectionDeg: 220, rainMm: 0 };

  const aqi = aqiData?.current?.european_aqi ?? 18;

  // Process Traffic Speeds
  let trafficMph = 23;
  let freeFlowMph = 24;
  if (trafficData?.flowSegmentData) {
    trafficMph = Math.round(trafficData.flowSegmentData.currentSpeed);
    freeFlowMph = Math.round(trafficData.flowSegmentData.freeFlowSpeed);
  }

  // Evaluate Trains & Barrier State Inference Engine
  let isClosed = false;
  let secondsToClosure = 300;
  let secondsRemainingDown = 160;
  let secondsElapsedDown = 0;
  let primaryService = "08:24 Southern to Portsmouth";
  let serviceProfile = "Stopping (P1 Dwell)";

  if (trainData?.trainServices && trainData.trainServices.length > 0) {
    const nextTrain = trainData.trainServices[0];
    primaryService = `${nextTrain.std} ${nextTrain.operator} to ${nextTrain.destination?.[0]?.locationName || 'Portsmouth'}`;
    
    // Parse ETA vs STA
    const now = new Date();
    const [stdH, stdM] = nextTrain.std.split(':').map(Number);
    const scheduledTime = new Date(now);
    scheduledTime.setHours(stdH, stdM, 0, 0);

    const diffSeconds = Math.round((scheduledTime.getTime() - now.getTime()) / 1000);
    const signallerLead = 80; // 80s lead time

    if (diffSeconds <= signallerLead && diffSeconds > -150) {
      // Barrier is currently DOWN
      isClosed = true;
      secondsElapsedDown = signallerLead - diffSeconds;
      secondsRemainingDown = Math.max(0, 160 - secondsElapsedDown);
      secondsToClosure = 0;
    } else if (diffSeconds > signallerLead) {
      // Barrier is currently OPEN
      isClosed = false;
      secondsToClosure = diffSeconds - signallerLead;
      secondsRemainingDown = 160;
    }
  }

  const responsePayload = {
    crossing: "West Worthing (MCB) • South St",
    updatedAt: new Date().toISOString(),
    barrier: {
      isClosed,
      secondsToClosure,
      secondsRemainingDown,
      secondsElapsedDown,
      secondsNextAfterOpen: 780,
      primaryService,
      serviceProfile
    },
    environmental: {
      ...weather,
      aqi
    },
    traffic: {
      currentMph: trafficMph,
      freeFlowMph: freeFlowMph,
      state: trafficMph < 5 ? "Stopped" : (trafficMph < 15 ? "Queueing" : "Free Flow")
    }
  };

  return new Response(JSON.stringify(responsePayload, null, 2), {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=10",
      "Access-Control-Allow-Origin": "*"
    }
  });
}
