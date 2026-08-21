import { runConformance } from '../_dev_/runtime-conformance.mjs';
const mod = await import('../dist/index.mjs');
const report = await runConformance(mod);
console.log('###REPORT###' + JSON.stringify(report));
if (report.failed > 0) process.exit(1);
