/**
 * A simulated Matter thermostat for tests: node matter-thermostat.cjs <storage dir> <port>.
 * Heats, cools and has auto. Starts at 21 °C in the room, heating to 20 °C, cooling to 26 °C, mode heat.
 * Prints "READY <pairing code>", then "MODE <n>", "HEAT <0.01 °C>", "COOL <0.01 °C>" as they change.
 * Reads commands on stdin, as if at the wall or in the room:
 *   "room 22.5"   the room's temperature changes
 *   "mode cool"   someone changes the mode at the thermostat (off, heat, cool, auto)
 *   "running heat" / "running cool" / "running idle"   the system starts or stops
 */

const readline = require("readline");
const { Endpoint, Environment, Logger, LogLevel, ServerNode, VendorId } = require("@matter/main");
const { ThermostatDevice } = require("@matter/main/devices/thermostat");
const { ThermostatServer } = require("@matter/main/behaviors/thermostat");
const { Thermostat } = require("@matter/main/clusters/thermostat");

const MODES = { off: Thermostat.SystemMode.Off, heat: Thermostat.SystemMode.Heat, cool: Thermostat.SystemMode.Cool, auto: Thermostat.SystemMode.Auto };

(async () => {
  Logger.level = LogLevel.ERROR;
  Environment.default.vars.set('storage.path', process.argv[2]);
  const node = await ServerNode.create({
    id: 'test-thermostat',
    network: { port: Number(process.argv[3]) },
    commissioning: { passcode: 20202021, discriminator: 3000 + Math.floor(Math.random() * 1000) },
    productDescription: { name: 'Test thermostat', deviceType: ThermostatDevice.deviceType },
    basicInformation: {
      vendorName: 'HomeHub Test', vendorId: VendorId(0xfff1), nodeLabel: 'Hall thermostat', productName: 'Test thermostat',
      productLabel: 'Test thermostat', productId: 0x8001, serialNumber: 'hh-test-t1', uniqueId: 'hh-test-t1',
    },
  });
  const device = ThermostatDevice.with(ThermostatServer.with('Heating', 'Cooling', 'AutoMode'));
  const thermostat = new Endpoint(device, {
    id: 'thermostat',
    thermostat: {
      localTemperature: 2100,
      occupiedHeatingSetpoint: 2000,
      occupiedCoolingSetpoint: 2600,
      minSetpointDeadBand: 25,
      systemMode: Thermostat.SystemMode.Heat,
      controlSequenceOfOperation: Thermostat.ControlSequenceOfOperation.CoolingAndHeating,
      thermostatRunningState: { heat: true, cool: false, fan: false },
    },
  });
  await node.add(thermostat);
  const ev = thermostat.events.thermostat;
  ev.systemMode$Changed.on((v) => console.log('MODE', v));
  ev.occupiedHeatingSetpoint$Changed.on((v) => console.log('HEAT', v));
  ev.occupiedCoolingSetpoint$Changed.on((v) => console.log('COOL', v));
  await node.start();
  console.log('READY', node.state.commissioning.pairingCodes.manualPairingCode);
  readline.createInterface({ input: process.stdin }).on('line', async (line) => {
    const [cmd, arg] = line.trim().split(/\s+/);
    try {
      if (cmd === 'room') await thermostat.set({ thermostat: { localTemperature: Math.round(Number(arg) * 100) } });
      if (cmd === 'mode') await thermostat.set({ thermostat: { systemMode: MODES[arg] } });
      if (cmd === 'running') await thermostat.set({ thermostat: { thermostatRunningState: { heat: arg === 'heat', cool: arg === 'cool', fan: arg !== 'idle' } } });
      console.log('DONE', line.trim());
    } catch (err) {
      console.log('FAILED', line.trim(), String(err));
    }
  });
})().catch((err) => { console.error(err); process.exit(1); });
