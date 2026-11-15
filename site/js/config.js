// config.js - ONE place for colours, constants and wording.
// Change a colour here and it changes on the map AND in the side panel
// (main.js copies COLORS into CSS variables like --evacuate).

export const COLORS = {
  // status colours (the only "real" colours in the app)
  evacuate: '#d64541',
  warning: '#e8a33d',
  monitor: '#4a90c2',
  // the fire
  fire: '#d9480f',          // squares burning now
  fireEdge: '#7c2504',
  forecast: '#f08c2e',      // forecast squares (opacity = probability)
  ring: '#ffb454',          // forecast rings (drawn over a dark casing)
  ringCasing: '#3b1205',
  actual: '#4a1010',        // real fire 1-3 h later (replay only)
  baseline: '#5d646b',      // "grow 1 km/h" rings
  pixel: '#ff7a1a',         // GOES fire pixels on the state map
  // exits
  exitClear: '#2f353b',
  exitBlocked: '#d64541',
  exitApproved: '#f4f6f8',
  ok: '#7fa58a',            // "passed safety check" green-grey
  // "Was it right?" (replay hindsight check) - kept apart from the status colours on purpose
  hit: '#3f9e78',           // forecast said fire, fire came
  missed: '#b0306a',        // fire came, forecast did not say so
  falseAlarm: '#9aa3ab',    // forecast said fire, no fire came
};

export const STATUS_ORDER = ['EVACUATE', 'WARNING', 'MONITOR'];
export const STATUS_COLOR = { EVACUATE: COLORS.evacuate, WARNING: COLORS.warning, MONITOR: COLORS.monitor };

// Map
export const BASE_STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';
export const TERRAIN_TILES = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
export const TERRAIN_EXAGGERATION = 1.5;
export const CALIFORNIA_BOUNDS = [-124.6, 32.3, -113.9, 42.2];   // [west, south, east, north]
export const PITCH_3D = 60;

// Replay
export const REPLAY_SPEEDS = [1000, 2000];     // milliseconds per replay hour
export const SPLIT_FADE = { delayMs: 700, durationMs: 1500, opacity: 0.8 };   // "real fire 3 h later" fade-in

// How many incidents get an AI "why it ranks high" line in STATE mode
export const TRIAGE_AI_TOP_N = 5;

// Wording that appears in more than one place
export const TEXT = {
  footer: 'AI drafts, code checks the forecast, a human decides.',
  alertLabel: 'Draft for county alert system, not sent',
  aiOffline: 'AI offline, forecast only',
  peopleLabel: 'towns warned before the fire reached them (fire within 1 km of the town point, from GOES-18)',
  whatIfBanner: (speed, dir) => `WHAT-IF · wind ${speed} km/h from ${dir} for the next 3 h · forecast re-run by the model · not real data`,
};

// What-if wind
export const WHATIF = { maxSpeed: 100, debounceMs: 350 };
