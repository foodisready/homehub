export interface DiscoveredDevice {
  ip:          string;
  alias:       string;
  model:       string;
  hasEmeter:   boolean;
  driverType:  string;
  driverConfig?: Record<string, unknown>;
  /** Hardware address, normalized by the driver. Identifies a device across IP changes. */
  mac?:        string;
  /** Found on the network, but HomeHub has no working login for it yet. */
  needsLogin?: boolean;
}

export interface EnergyMetrics {
  wattage: number | null;
  voltage: number | null;
  current: number | null;
}

export interface DeviceDriver {
  /** Stable key stored in the DB — 'kasa' | 'shelly' */
  readonly type: string;

  /** Turn device on or off. config is the parsed driver_config JSON for this device. */
  setPower(ip: string, on: boolean, config?: Record<string, unknown>): Promise<void>;

  /** Read current on/off state. */
  getPower(ip: string, config?: Record<string, unknown>): Promise<boolean>;

  /** Read energy metrics, or null if not supported by this device/driver. */
  getEnergy(ip: string, config?: Record<string, unknown>): Promise<EnergyMetrics | null>;

  /**
   * Probe a single IP — verify the device exists and return its metadata.
   * Returns null if the device at that IP does not belong to this driver.
   */
  probe(ip: string, config?: Record<string, unknown>): Promise<Omit<DiscoveredDevice, 'driverType'> | null>;

  /** How long after a switch to read the state back. Defaults to 1.2 s; a garage door needs to finish moving. */
  readonly confirmAfterMs?: number;

  /** Network-level broadcast/scan discovery. */
  discover(): Promise<DiscoveredDevice[]>;
}
