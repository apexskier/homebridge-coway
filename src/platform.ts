import {
  API,
  DynamicPlatformPlugin,
  Logger,
  PlatformAccessory,
  PlatformConfig,
  Service,
  Characteristic,
} from "homebridge";
import { parse } from "node-html-parser";

import { PLATFORM_NAME, PLUGIN_NAME } from "./settings";
import { AccessoryContext, CowayPlatformAccessory } from "./platformAccessory";
import { Config } from "./config";

/**
 * HomebridgePlatform
 * This class is the main constructor for your plugin, this is where you should
 * parse the user config and discover/register accessories with Homebridge.
 */
export class CowayHomebridgePlatform implements DynamicPlatformPlugin {
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
    this.api.on("didFinishLaunching", async () => {
      log.debug("Executed didFinishLaunching callback");
      // run the method to discover / register your devices as accessories
      await this.authorize();
      await this.discoverDevices();
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

  accessToken: string | null = null;
  refreshToken: string | null = null;

  async discoverDevices() {
    const listResponse = await this.fetch(
      "https://iocareapi.iot.coway.com/api/v1/com/user-devices?pageIndex=0&pageSize=100",
    );
    const { data } = (await listResponse.json()) as {
      data: {
        deviceInfos: ReadonlyArray<{
          barcode: string;
          dvcBrandCd: string;
          dvcModel: string;
          dvcNick: string;
          dvcTypeCd: string;
          prodName: string;
        }>;
        first: boolean;
        last: boolean;
        numberOfElements: number;
        reqPageIndex: number;
        reqPageSize: number;
        totalElements: number;
        totalPages: number;
      };
    };
    if (data.totalPages !== 1) {
      this.log.warn("more than one page of devices");
    }

    for (const device of data.deviceInfos) {
      const deviceId = device.barcode;
      const existingAccessory = this.accessories.find(
        (accessory) => accessory.UUID === this.api.hap.uuid.generate(deviceId),
      );
      if (existingAccessory) {
        this.log.info(
          "Restoring existing accessory from cache:",
          device.dvcNick,
        );
        new CowayPlatformAccessory(this, existingAccessory);
      } else {
        this.log.info("Adding new accessory:", device.dvcNick);
        const accessory = new this.api.platformAccessory<AccessoryContext>(
          device.dvcNick,
          this.api.hap.uuid.generate(deviceId),
        );
        (accessory.context as AccessoryContext).device = device;
        new CowayPlatformAccessory(this, accessory);
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [
          accessory,
        ]);
      }
    }
  }

  async authorize() {
    const config = this.config as unknown as Config;

    const openIDURL = new URL(
      "https://id.coway.com/auth/realms/cw-account/protocol/openid-connect/auth",
    );
    openIDURL.searchParams.append("auth_type", "0");
    openIDURL.searchParams.append("response_type", "code");
    openIDURL.searchParams.append("client_id", "cwid-prd-iocare-20240327");
    openIDURL.searchParams.append("ui_locales", "en-US");
    openIDURL.searchParams.append("dvc_cntry_id", "US");
    // openIDURL.searchParams.append(
    //   "redirect_uri",
    //   "https://iocare-redirect.iot.coway.com/redirect_bridge.html"
    // );

    const openIDInitResponse = await fetch(
      openIDURL.toString() +
        `&redirect_uri=https://iocare-redirect.iot.coway.com/redirect_bridge.html`,
      {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (iPhone; CPU iPhone OS 10_3_1 like Mac OS X) AppleWebKit/603.1.30 (KHTML, like Gecko) Version/10.0 Mobile/14E304 Safari/602.1 app",
          Accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
        },
      },
    );
    const body = await openIDInitResponse.text();
    const htmlRoot = parse(body);
    const loginForm = htmlRoot.querySelector("#kc-form-login");
    if (!loginForm) {
      this.log.error("missing login form", body);
      throw new this.api.hap.HapStatusError(
        this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
      );
    }
    const loginUrl = loginForm.getAttribute("action");
    if (!loginUrl) {
      this.log.error("missing login url", body);
      throw new this.api.hap.HapStatusError(
        this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
      );
    }
    const loginMethod = loginForm.getAttribute("method");
    const openIDCookies = (
      openIDInitResponse.headers as unknown as { getSetCookie(): string[] }
    )
      .getSetCookie()
      .map((cookieStr) => cookieStr.split(";")[0])
      .join("; ");

    const loginRequestBody = new URLSearchParams();
    loginRequestBody.append("clientName", "IOCARE");
    loginRequestBody.append("termAgreementStatus", "");
    loginRequestBody.append("idp", "");
    loginRequestBody.append("username", config.username);
    loginRequestBody.append("password", config.password);
    loginRequestBody.append("rememberMe", "on");

    this.accessToken = "";
    // need to use search params for proper encoding for some reason
    const loginRequestBodyRaw = loginRequestBody.toString();
    const loginResponse = await fetch(loginUrl, {
      method: loginMethod,
      body: loginRequestBodyRaw,
      redirect: "manual",
      headers: {
        Cookie: openIDCookies ?? "",
        "Content-Type": "application/x-www-form-urlencoded",

        "User-Agent":
          "Mozilla/5.0 (iPhone; CPU iPhone OS 10_3_1 like Mac OS X) AppleWebKit/603.1.30 (KHTML, like Gecko) Version/10.0 Mobile/14E304 Safari/602.1 app",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });

    if (loginResponse.status !== 302) {
      this.log.error(
        "authenticate didn't redirect",
        await loginResponse.text(),
      );
      throw new this.api.hap.HapStatusError(
        this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
      );
    }
    const rawLocation = loginResponse.headers.get("location");
    if (!rawLocation) {
      this.log.error("missing location header", await loginResponse.text());
      throw new this.api.hap.HapStatusError(
        this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
      );
    }

    const location = new URL(rawLocation);

    const tokenResponse = await this.fetch(
      "https://iocareapi.iot.coway.com/api/v1/com/token",
      {
        method: "POST",
        body: JSON.stringify({
          authCode: location.searchParams.get("code"),
          redirectUrl: location.href.split("?")[0],
        }),
        headers: {
          "content-type": "application/json",
        },
      },
    );

    // TODO: refresh token
    const {
      data: { accessToken, refreshToken },
    } = (await tokenResponse.json()) as {
      data: { accessToken: string; refreshToken: string };
    };
    this.accessToken = accessToken;
    this.refreshToken = refreshToken;
  }

  // TODO: This isn't working, I'm getting 400 rate limiting errors of some sort
  async reauthorize() {
    const tokenResponse = await fetch(
      "https://iocareapi.iot.coway.com/api/v1/com/refresh-token",
      {
        method: "POST",
        body: JSON.stringify({ refreshToken: this.refreshToken }),
        headers: {
          "content-type": "application/json",
        },
      },
    );
    if (tokenResponse.status !== 200) {
      this.log.debug(
        "refresh token failed",
        tokenResponse,
        await tokenResponse.text(),
      );
      throw new this.api.hap.HapStatusError(
        this.api.hap.HAPStatus.INSUFFICIENT_AUTHORIZATION,
      );
    }

    const {
      data: { accessToken, refreshToken },
    } = (await tokenResponse.json()) as {
      data: { accessToken: string; refreshToken: string };
    };
    this.accessToken = accessToken;
    this.refreshToken = refreshToken;
  }

  async fetch(input: RequestInfo | URL, init?: RequestInit) {
    let response: Response;
    try {
      response = await fetch(input, {
        ...init,
        headers: {
          ...init?.headers,
          ...(this.accessToken
            ? { Authorization: "Bearer " + this.accessToken }
            : {}),
        },
      });
    } catch (error) {
      this.log.error("failed to fetch", error);
      throw new this.api.hap.HapStatusError(
        this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
      );
    }

    if (response.status === 401) {
      this.accessToken = "";
      this.log.warn(
        `auth token expired, reauthenticating and retrying (${
          init?.method ?? "GET"
        } ${input.toString()})`,
        await response.text(),
      );
      await this.authorize();
      return this.fetch(input, init);
    }

    if (response.status === 400) {
      const body = await response.json();
      if (body.message.startsWith("Unauthenticated")) {
        this.log.warn(`unauthenticated, trying again`, body);
        await this.authorize();
        return this.fetch(input, init);
      }
    }

    if (!response.ok) {
      this.log.warn("non-ok response", input.toString(), await response.text());
      throw new this.api.hap.HapStatusError(
        this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
      );
    }

    if (response.status !== 200) {
      this.log.warn("non-200 response", await response.text());
      throw new this.api.hap.HapStatusError(
        this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
      );
    }

    return response;
  }
}
