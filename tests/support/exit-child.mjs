// A worker that renders one miss and then ends, for the REG-3 exit-drain tests. Runs the BUILT
// package, the artifact that ships. argv: <dist entry> <api base url> <mode>
//   exit    - lets the event loop empty, so `beforeExit` fires
//   sigterm - keeps the loop alive and sends itself SIGTERM once the first send has failed
//   off     - `exit`, with flushOnExit: false (the control)
const [, , dist, apiUrl, mode] = process.argv;
const { createLangsysServer, t } = await import(dist);
const langsys = createLangsysServer({
    projectId: 'p',
    apiKey: 'wk',
    baseLocale: 'en',
    apiUrl,
    flushOnExit: mode !== 'off',
});
await langsys.run({ locale: 'it' }, () => t('Farewell'));
if (mode === 'sigterm') {
    const alive = setInterval(() => {}, 1000);
    // After the scheduled drain has sent (and the double has failed) the first attempt.
    setTimeout(() => process.kill(process.pid, 'SIGTERM'), 300);
    void alive;
}
