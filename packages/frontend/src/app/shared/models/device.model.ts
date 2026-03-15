export interface Device {
  id: number;
  alias: string;
  ip: string;
  model: string | null;
  hasEmeter: boolean;
  icon: string | null;
  state: boolean;
  wattage: number | null;
  online: boolean;
}
