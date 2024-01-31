import {
  API,
  DynamicPlatformPlugin,
  Logger,
  PlatformAccessory,
  PlatformConfig,
  Service,
  Characteristic,
} from "homebridge";

import { PLATFORM_NAME, PLUGIN_NAME } from "./settings";
import {
  AccessoryContext,
  SmartEnviPlatformAccessory,
} from "./platformAccessory";
import { Config } from "./config";

/**
 * HomebridgePlatform
 * This class is the main constructor for your plugin, this is where you should
 * parse the user config and discover/register accessories with Homebridge.
 */
export class SmartEnviHomebridgePlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service = this.api.hap.Service;
  public readonly Characteristic: typeof Characteristic =
    this.api.hap.Characteristic;

  public readonly accessories: PlatformAccessory<AccessoryContext>[] = [];

  constructor(
    public readonly log: Logger,
    public readonly config: PlatformConfig & Partial<Config>,
    public readonly api: API,
  ) {
    this.log.debug("Finished initializing platform:", this.config);

    if (!config.username) {
      this.log.error("missing username");
      return;
    }

    if (!config.password) {
      this.log.error("missing password");
      return;
    }

    // When this event is fired it means Homebridge has restored all cached accessories from disk.
    // Dynamic Platform plugins should only register new accessories after this event was fired,
    // in order to ensure they weren't added to homebridge already. This event can also be used
    // to start discovery of new accessories.
    this.api.on("didFinishLaunching", () => {
      log.debug("Executed didFinishLaunching callback");
      // run the method to discover / register your devices as accessories
      this.discoverDevices();
    });
  }

  /**
   * This function is invoked when homebridge restores cached accessories from disk at startup.
   * It should be used to setup event handlers for characteristics and update respective values.
   */
  configureAccessory(accessory: PlatformAccessory<AccessoryContext>) {
    this.log.info("Loading accessory from cache:", accessory.displayName);

    // add the restored accessory to the accessories cache so we can track if it has already been registered
    this.accessories.push(accessory);
  }

  authToken: string | null = null;

  async discoverDevices() {
    const config = this.config as unknown as Config;

    const loginRequest = new FormData();
    loginRequest.append("username", config.username);
    loginRequest.append("password", config.password);
    loginRequest.append("login_type", `1`); // 1=email?
    loginRequest.append("device_type", "ios");
    loginRequest.append("device_id", "D46E2A18-EE5D-48FF-AFE8-AAAAAAAAAAAA");
    const loginResponse = await this.fetch(
      "https://app-apis.enviliving.com/apis/v1/auth/login",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: Array.from(
          loginRequest as unknown as ReadonlyArray<[string, string]>,
        )
          .map(([name, value]) => `${name}=${value}`)
          .join("&"),
      },
    );
    const {
      data: { token: authToken },
    } = (await loginResponse.json()) as { data: { token: string } };
    this.authToken = authToken;

    const listResponse = await this.fetch(
      "https://app-apis.enviliving.com/apis/v1/device/list",
      {
        headers: {
          Authorization: "Bearer " + authToken,
        },
      },
    );
    const { data: devices } = (await listResponse.json()) as {
      data: ReadonlyArray<{
        id: number;
        ambient_temperature: number; // F
        current_mode: number;
        current_temperature: number; // F - target
        device_status: number;
        group_id: string;
        group_name: string;
        location_name: string;
        name: string;
        serial_no: string;
        state: number;
        status: number;
        temperature_unit: "F" | "C";
        user_id: number;
      }>;
    };

    for (const device of devices) {
      const deviceEndpoint = device.serial_no;
      const existingAccessory = this.accessories.find(
        (accessory) =>
          accessory.UUID === this.api.hap.uuid.generate(deviceEndpoint),
      );
      if (existingAccessory) {
        this.log.info("Restoring existing accessory from cache:", device.name);
        new SmartEnviPlatformAccessory(this, existingAccessory);
      } else {
        this.log.info("Adding new accessory:", device.name);
        const accessory = new this.api.platformAccessory<AccessoryContext>(
          device.name,
          this.api.hap.uuid.generate(deviceEndpoint),
        );
        (accessory.context as AccessoryContext).device = device;
        new SmartEnviPlatformAccessory(this, accessory);
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [
          accessory,
        ]);
      }
    }
  }

  async fetch(input: RequestInfo | URL, init?: RequestInit) {
    let response: Response;
    try {
      response = await fetch(input, {
        ...init,
        headers: {
          ...init?.headers,
          ...(this.authToken
            ? { Authorization: "Bearer " + this.authToken }
            : {}),
        },
      });
    } catch (error) {
      this.log.error("failed to fetch", error);
      throw new this.api.hap.HapStatusError(
        this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
      );
    }

    if (!response.ok) {
      throw new this.api.hap.HapStatusError(
        this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
      );
    }

    if (response.status === 401) {
      throw new this.api.hap.HapStatusError(
        this.api.hap.HAPStatus.INSUFFICIENT_AUTHORIZATION,
      );
    }

    if (response.status !== 200) {
      throw new this.api.hap.HapStatusError(
        this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
      );
    }

    return response;
  }
}
