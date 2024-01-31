import { PlatformAccessory } from "homebridge";
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

export class SmartEnviPlatformAccessory {
  data: {
    current_mode: 1;
    current_temperature: number;
    device_status: 1;
    state: 1 | 0; // 0 off, 1 on
    status: 1;
    night_light_setting: {
      brightness: 50;
      auto: false;
      on: false;
      off: true;
      color: {
        r: 255;
        g: 255;
        b: 255;
      };
    };
    ambient_temperature: 63;
    temperature_unit: "F" | "C";
  } | null = null;

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
        this.data?.state === 1
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
        this.data?.state === 1
          ? this.platform.Characteristic.TargetHeatingCoolingState.HEAT
          : this.platform.Characteristic.TargetHeatingCoolingState.OFF,
      )
      .onSet(async (value) => {
        await this.updateThermostat({ state: value as 0 | 1 });
      });
    thermostatService
      .getCharacteristic(this.platform.Characteristic.CurrentTemperature)
      .onGet(() => fToC(this.data?.ambient_temperature ?? 72));
    thermostatService
      .getCharacteristic(this.platform.Characteristic.TargetTemperature)
      .onGet(() => Math.max(10, fToC(this.data?.current_temperature ?? 72)))
      .onSet(async (value) => {
        await this.updateThermostat({ temperature: cToF(Number(value)) });
      });
    thermostatService
      .getCharacteristic(this.platform.Characteristic.TemperatureDisplayUnits)
      .onGet(() =>
        this.data?.temperature_unit === "F"
          ? this.platform.Characteristic.TemperatureDisplayUnits.FAHRENHEIT
          : this.platform.Characteristic.TemperatureDisplayUnits.CELSIUS,
      );

    const nightLightService =
      this.accessory.getService(this.platform.Service.Lightbulb) ||
      this.accessory.addService(this.platform.Service.Lightbulb);
    nightLightService
      .getCharacteristic(this.platform.Characteristic.Name)
      .setValue("Night light");
    nightLightService
      .getCharacteristic(this.platform.Characteristic.On)
      .onGet(() => this.data?.night_light_setting.on ?? false);
    nightLightService
      .getCharacteristic(this.platform.Characteristic.Brightness)
      .onGet(() => this.data?.night_light_setting.brightness ?? 0);
    nightLightService
      .getCharacteristic(this.platform.Characteristic.Hue)
      .onGet(() => {
        // todo
        const { r, g, b } = this.data?.night_light_setting.color ?? {
          r: 255,
          g: 255,
          b: 255,
        };
        const [h] = convert.rgb.hsl([r, g, b]);
        return h;
      });
    nightLightService
      .getCharacteristic(this.platform.Characteristic.Saturation)
      .onGet(() => {
        // todo
        const { r, g, b } = this.data?.night_light_setting.color ?? {
          r: 255,
          g: 255,
          b: 255,
        };
        const [, s] = convert.rgb.hsl([r, g, b]);
        return s;
      });

    // statusLightService
    //   .getCharacteristic(this.platform.Characteristic.On)
    //   .onGet(async () => {
    //     this.platform.log.debug("getting on", this.accessory.displayName);
    //     const {
    //       data: { led_on },
    //     } = await (
    //       await this.fetch(
    //         `https://api-user.e2ro.com/${this.accessory.context.eero.url}`
    //       )
    //     ).json();
    //     return led_on;
    //   })
    //   .onSet(async (value) => {
    //     this.platform.log.debug(
    //       "setting on",
    //       value,
    //       this.accessory.displayName
    //     );
    //     await this.fetch(
    //       `https://api-user.e2ro.com${this.accessory.context.eero.resources.led_action}`,
    //       {
    //         method: "PUT",
    //         body: JSON.stringify({
    //           led_on: value,
    //         }),
    //       }
    //     );
    //   });

    // statusLightService
    //   .getCharacteristic(this.platform.Characteristic.Brightness)
    //   .onGet(async () => {
    //     this.platform.log.debug(
    //       "getting brightness",
    //       this.accessory.displayName
    //     );
    //     const {
    //       data: { led_brightness },
    //     } = await (
    //       await this.fetch(
    //         `https://api-user.e2ro.com/${this.accessory.context.eero.url}`
    //       )
    //     ).json();
    //     return led_brightness;
    //   })
    //   .onSet(async (value) => {
    //     this.platform.log.debug(
    //       "setting brightness",
    //       value,
    //       this.accessory.displayName
    //     );
    //     await this.fetch(
    //       `https://api-user.e2ro.com${this.accessory.context.eero.resources.led_action}`,
    //       {
    //         method: "PUT",
    //         body: JSON.stringify({
    //           led_on: !!value,
    //           led_brightness: value,
    //         }),
    //       }
    //     );
    //   });

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

  private async updateSettings(body: { child_lock_setting: boolean }) {
    await this.platform.fetch(
      `https://app-apis.enviliving.com/apis/v1/device/update/settings/${this.accessory.context.device.id}`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
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
    this.data = data;
  }
}
