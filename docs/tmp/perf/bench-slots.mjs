// Measures slot generation cost cold (first call in a fresh process, as in a new Worker isolate)
// and warm, over the ranges the widget and the manage page request.
import { generateSlots } from '../../../dist/core/slots.js';
import { addDaysToDateKey } from '../../../dist/core/time.js';

const days = Number(process.argv[2] ?? 30);
const service = {
  durationMin: 120,
  schedule: [{ days: [0, 1, 2, 3, 4, 5, 6], firstStart: '09:00', lastStart: '16:00', intervalMin: 30 }],
};
const run = () => {
  let slots = 0;
  for (let i = 0; i < days; i++) slots += generateSlots(service, addDaysToDateKey('2026-09-29', i), 'Europe/Lisbon').length;
  return slots;
};
const cpu = () => process.cpuUsage().user / 1000;
let t = cpu();
const slots = run();
const cold = cpu() - t;
t = cpu();
for (let i = 0; i < 5; i++) run();
const warm = (cpu() - t) / 5;
console.log(`${days} days, ${slots} slots: cold ${cold.toFixed(1)} ms, warm ${warm.toFixed(1)} ms (${((warm * 1000) / slots).toFixed(1)} µs/slot)`);
