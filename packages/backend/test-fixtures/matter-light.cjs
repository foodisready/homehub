/**
 * A simulated Matter on/off light for tests: node matter-light.cjs <storage dir> <port>.
 * Prints "READY <pairing code>", then "LIGHT ON"/"LIGHT OFF" as it's switched.
 * Prints "DECOMMISSIONED" once its last controller has removed it.
 * Reads commands on stdin: "toggle" (as if switched at the wall), "fabrics" (prints FABRICS <n>).
 */

const readline = require("readline");
const { Endpoint, Environment, Logger, LogLevel, ServerNode, VendorId } = require("@matter/main");
const { OnOffLightDevice } = require("@matter/main/devices/on-off-light");

(async () => {
  Logger.level = LogLevel.ERROR;
  const env = Environment.default;
  env.vars.set('storage.path', process.argv[2]);
  const node = await ServerNode.create({
    id: 'test-light',
    network: { port: Number(process.argv[3]) },
    commissioning: { passcode: 20202021, discriminator: 3000 + Math.floor(Math.random() * 1000) },
    productDescription: { name: 'Test light', deviceType: OnOffLightDevice.deviceType },
    basicInformation: {
      vendorName: 'HomeHub Test', vendorId: VendorId(0xfff1), nodeLabel: 'Test light', productName: 'Test light',
      productLabel: 'Test light', productId: 0x8000, serialNumber: 'hh-test-1', uniqueId: 'hh-test-1',
    },
  });
  const light = new Endpoint(OnOffLightDevice, { id: 'light' });
  await node.add(light);
  light.events.onOff.onOff$Changed.on((on) => console.log(on ? 'LIGHT ON' : 'LIGHT OFF'));
  node.lifecycle?.decommissioned?.on?.(() => console.log('DECOMMISSIONED'));
  node.events?.commissioning?.commissioned$Changed?.on?.((v) => { if (!v) console.log('DECOMMISSIONED'); });
  await node.start();
  console.log('READY', node.state.commissioning.pairingCodes.manualPairingCode);
  readline.createInterface({ input: process.stdin }).on('line', async (line) => {
    if (line === 'toggle') await light.set({ onOff: { onOff: !light.state.onOff.onOff } });
    if (line === 'fabrics') {
      try { console.log('FABRICS', Object.keys(node.state.commissioning.fabrics ?? {}).length); } catch (err) { console.log('FABRICS ?', String(err)); }
    }
  });
})().catch((err) => { console.error(err); process.exit(1); });
