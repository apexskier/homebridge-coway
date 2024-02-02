import { CharacteristicValue, PlatformAccessory } from "homebridge";
import convert from "color-convert";

import { SmartEnviHomebridgePlatform } from "./platform";

export interface AccessoryContext {
  device: {
    id: number;
    serial_no: string;
    name: string;
  };
}

function fToC(f: number) {
  return (f - 32) * (5 / 9);
}

function cToF(c: number) {
  return c * (9 / 5) + 32;
}

interface NightLightData {
  brightness: number; // 0 to 100 ?
  auto: boolean;

  // why have both?
  on: boolean;
  off: boolean;

  color: {
    r: number; // 0 to 255
    g: number; // 0 to 255
    b: number; // 0 to 255
  };
}

interface OnlineDeviceData {
  // value here is F if `temperature_unit` is F, C if C
  current_temperature: number;
  ambient_temperature: number;
  device_status: 1; // 0 offline, 1 online ?
  state: 1 | 0; // 0 off, 1 on ?
  current_mode: 1; // ?
  status: 1; // ?
  firmware_version: string;
  temperature_unit: "F" | "C"; // ?
  auto: {
    current_temperature: number;
    state: 1;
  };
  is_hold: boolean;
  night_light_setting: NightLightData;
}

type DeviceData = OnlineDeviceData | { device_status: 0 };

function isDeviceOffline(data: DeviceData): data is { device_status: 0 } {
  return data.device_status === 0;
}

export class SmartEnviPlatformAccessory {
  data: DeviceData = { device_status: 0 };

  constructor(
    private readonly platform: SmartEnviHomebridgePlatform,
    private readonly accessory: PlatformAccessory<AccessoryContext>,
  ) {
    this.accessory
      .getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, "eheat")
      .setCharacteristic(
        this.platform.Characteristic.FirmwareRevision,
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        require("../package.json").version,
      )
      .setCharacteristic(
        this.platform.Characteristic.Name,
        this.accessory.context.device.name,
      )
      .setCharacteristic(
        this.platform.Characteristic.SerialNumber,
        this.accessory.context.device.serial_no,
      );

    const thermostatService =
      this.accessory.getService(this.platform.Service.Thermostat) ||
      this.accessory.addService(this.platform.Service.Thermostat);
    thermostatService
      .getCharacteristic(
        this.platform.Characteristic.CurrentHeatingCoolingState,
      )
      .onGet(() =>
        this.guardedOnlineData().state === 1
          ? this.platform.Characteristic.CurrentHeatingCoolingState.HEAT
          : this.platform.Characteristic.CurrentHeatingCoolingState.OFF,
      );
    thermostatService
      .getCharacteristic(this.platform.Characteristic.TargetHeatingCoolingState)
      .setProps({
        validValues: [
          this.platform.Characteristic.TargetHeatingCoolingState.OFF,
          this.platform.Characteristic.TargetHeatingCoolingState.HEAT,
        ],
      })
      .onGet(() =>
        this.guardedOnlineData().state === 1
          ? this.platform.Characteristic.TargetHeatingCoolingState.HEAT
          : this.platform.Characteristic.TargetHeatingCoolingState.OFF,
      )
      .onSet(async (value) => this.updateThermostat({ state: value as 0 | 1 }));
    thermostatService
      .getCharacteristic(this.platform.Characteristic.CurrentTemperature)
      .onGet(() => {
        const data = this.guardedOnlineData();
        if (data.temperature_unit === "F") {
          return fToC(data.ambient_temperature);
        } else {
          return data.ambient_temperature;
        }
      });
    thermostatService
      .getCharacteristic(this.platform.Characteristic.TargetTemperature)
      .onGet(() => {
        const data = this.guardedOnlineData();
        if (data.temperature_unit === "F") {
          return fToC(data.current_temperature);
        } else {
          return data.current_temperature;
        }
      })
      .onSet(async (value) => {
        // if the unit changed on the device between now and the last poll, this will be wrong
        // to minimize this edge case, pull status immediately (`await this.updateStatus`)
        // this is an edge enough case that I don't think it's worth fixing
        let temperature = value as number;
        if (this.guardedOnlineData().temperature_unit === "F") {
          temperature = cToF(temperature);
        }
        return this.updateThermostat({ temperature });
      });
    thermostatService
      .getCharacteristic(this.platform.Characteristic.TemperatureDisplayUnits)
      .onGet(() =>
        this.guardedOnlineData().temperature_unit === "F"
          ? this.platform.Characteristic.TemperatureDisplayUnits.FAHRENHEIT
          : this.platform.Characteristic.TemperatureDisplayUnits.CELSIUS,
      )
      .onSet(async (value) =>
        this.platform.updateUserSettings({
          temperature_unit:
            value ===
            this.platform.Characteristic.TemperatureDisplayUnits.FAHRENHEIT
              ? "F"
              : "C",
        }),
      );

    const nightLightService =
      this.accessory.getService(this.platform.Service.Lightbulb) ||
      this.accessory.addService(this.platform.Service.Lightbulb);
    nightLightService
      .getCharacteristic(this.platform.Characteristic.Name)
      .setValue("Night light");
    nightLightService
      .getCharacteristic(this.platform.Characteristic.On)
      // TODO: need to test, this might need to be replaced with
      // const data = this.guardedOnlineData();
      // return data.night_light_setting.auto
      //   ? data.night_light_setting.brightness > 0
      //   : data.night_light_setting.on;
      .onGet(() => !this.guardedOnlineData().night_light_setting.off);
    // TODO: all this needs testing still
    //
    // NOTE: both envi and apple don't actually allow setting the brightness
    // component of the actual color, brightness is managed separately
    //
    // according to https://nrchkb.github.io/wiki/service/lightbulb/, homekit uses HSV
    const wrapLog =
      (label: string, fn: (value: CharacteristicValue) => Promise<void>) =>
      (value: CharacteristicValue) => {
        this.platform.log.info(label, value);
        return fn(value);
      };
    nightLightService
      .getCharacteristic(this.platform.Characteristic.Brightness)
      .onGet(() => this.guardedOnlineData().night_light_setting.brightness)
      .onSet(
        wrapLog("setting brightness", async (value) =>
          // value between 0 and 100
          this.updateNightLightSettings({ brightness: value as number }),
        ),
      );
    nightLightService
      .getCharacteristic(this.platform.Characteristic.Hue)
      .onGet(() => {
        const [h] = this.hsvColor();
        return h;
      })
      .onSet(
        wrapLog("setting hue", async (value) => {
          // value between 0 and 360
          const [, s, v] = this.hsvColor();
          const [r, g, b] = convert.hsv.rgb([value as number, s, v]);
          return this.updateNightLightSettings({ color: { r, g, b } });
        }),
      );
    nightLightService
      .getCharacteristic(this.platform.Characteristic.Saturation)
      .onGet(() => {
        const [, s] = this.hsvColor();
        return s;
      })
      .onSet(
        wrapLog("setting saturation", async (value) => {
          // value between 0 and 100
          const [h, , v] = this.hsvColor();
          const [r, g, b] = convert.hsv.rgb([h, value as number, v]);
          return this.updateNightLightSettings({ color: { r, g, b } });
        }),
      );

    this.poll();
  }

  private async updateThermostat(
    body: { state: 1 | 0 } | { temperature: number },
  ) {
    this.platform.log.info("updating thermostat", body);
    const response = await this.platform.fetch(
      `https://app-apis.enviliving.com/apis/v1/device/update-temperature/${this.accessory.context.device.id}`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      },
    );
    this.platform.log.info("update thermostat response", await response.json());
    await this.updateStatus();
  }

  private async updateNightLightSettings(body: Partial<NightLightData>) {
    await this.platform.fetch(
      `https://app-apis.enviliving.com/apis/v1/device/night-light-setting/${this.accessory.context.device.id}`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          ...this.guardedOnlineData(),
          body,
        }),
      },
    );
    await this.updateStatus();
  }

  private poll() {
    this.updateStatus()
      .catch((err) => {
        this.platform.log.error(
          "update status error",
          err,
          (err as Error).stack,
        );
      })
      .then(() => setTimeout(this.poll.bind(this), 10 * 1000));
  }

  private async updateStatus() {
    const { data } = await (
      await this.platform.fetch(
        `https://app-apis.enviliving.com/apis/v1/device/${this.accessory.context.device.id}`,
      )
    ).json();
    this.platform.log.debug("updated status");
    this.data = data;
  }

  private guardedOnlineData(): OnlineDeviceData {
    if (isDeviceOffline(this.data)) {
      throw new this.platform.api.hap.HapStatusError(
        this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
      );
    }
    return this.data;
  }

  private hsvColor(): [number, number, number] {
    const { r, g, b } = this.guardedOnlineData().night_light_setting.color;
    return convert.rgb.hsv([r, g, b]);
  }
}
