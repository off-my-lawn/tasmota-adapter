/**
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.*
 */

'use strict';

import { Adapter, Database } from 'gateway-addon';
import fetch from 'node-fetch';
import { Browser, tcp } from 'dnssd';
import { isIPv4 } from 'net';
import { PowerPlug } from './power-plug';
import { authConfig, getData, getStatus } from './api';
import { DimmableLight, ColorLight, ColorTemperatureLight } from './light';
import crypto from 'crypto';

export class TasmotaAdapter extends Adapter {
  private httpBrowser?: Browser;
  private devices: { [key: string]: PowerPlug } = {};

  constructor(addonManager: any, private manifest: any) {
    super(addonManager, manifest.display_name, manifest.id);
    addonManager.addAdapter(this);
    this.startDiscovery();

    setTimeout(() => {
      this.stopDiscovery();
    }, 5000);
  }

  public startPairing(_timeoutSeconds: number) {
    console.log('Start pairing');
    this.startDiscovery();
    this.load();
  }

  private async load() {
    console.log(`Loading devices from config`);

    const {
      pollInterval,
      password
    } = this.manifest.moziot.config;

    const db = new Database(this.manifest.name);
    await db.open();
    const config = await db.loadConfig();

    if (config.devices) {
      for (const device of config.devices) {
        const {
          hostname,
          port
        } = device;

        if (!device.id) {
          device.id = `${crypto.randomBytes(16).toString('hex')}`;
          console.log(`Adding id for device at ${hostname}`);
        }

        const url = `${hostname}:${port}`;
        await this.createDevice(url, hostname, hostname, password, pollInterval);
      }
    }

    await db.saveConfig(config);
  }

  private startDiscovery() {
    this.httpBrowser = new Browser(tcp('http'));

    this.httpBrowser.on('serviceUp', async service => {
      const host = this.removeTrailingDot(service.host);
      console.log(`Discovered http service at ${host}`);
      const addresses: string[] = service?.addresses;
      this.handleService(host, addresses.filter(isIPv4)[0] || host, service.port);
    });

    this.httpBrowser.start();
  }

  private removeTrailingDot(str: string) {
    if (str.length > 0 && str.lastIndexOf('.') === (str.length - 1)) {
      return str.substring(0, str.length - 1);
    }

    return str;
  }

  private async handleService(name: string, host: string, port: number) {
    const {
      pollInterval,
      password
    } = this.manifest.moziot.config;

    const url = `${host}:${port}`;

    console.log(`Probing ${url}`);

    const result = await fetch(`http://${url}`, authConfig(password));

    if (result.status == 200) {
      const body = await result.text();

      if (body.indexOf('Tasmota') >= 0) {
        console.log(`Discovered Tasmota at ${name}`);
        await this.createDevice(url, name, host, password, pollInterval);
      } else {
        console.log(`${name} seems not to be a Tasmota device`);
      }
    } else {
      console.log(`${name} responded with ${result.statusText} (${result.status})`);
    }
  }

  private async createDevice(url: string, name: string, host: string, password: string, pollInterval: number) {
    let existingDevice = this.devices[name];

    if (!existingDevice) {
      console.log(`Creating device ${name} (${host})`);
      const data = await getData(url);
      const device = new PowerPlug(this, name, host, password, data);
      this.devices[name] = device;
      this.handleDeviceAdded(device);
      device.startPolling(Math.max(pollInterval || 1000, 500));

      const colorResponse = await getStatus(host, password, 'Color');
      const colorResult = await colorResponse.json();
      const color: string = colorResult?.Color || "";

      if (color.length >= 6) {
        console.log('Found color light');
        const colorDevice = new ColorLight(this, `${name}-color`, host, password);
        this.handleDeviceAdded(colorDevice);
        colorDevice.startPolling(Math.max(pollInterval || 1000, 500));
      } else {
        if (color.length == 2) {
          console.log('Found dimmable light');
          const dimmableLight = new DimmableLight(this, `${name}-light`, host, password);
          this.handleDeviceAdded(dimmableLight);
          dimmableLight.startPolling(Math.max(pollInterval || 1000, 500));
        } else if (color.length == 4) {
          console.log('Found color temperature light');
          const colorTemperatureLight = new ColorTemperatureLight(this, `${name}-light`, host, password);
          this.handleDeviceAdded(colorTemperatureLight);
          colorTemperatureLight.startPolling(Math.max(pollInterval || 1000, 500));
        }
      }
    }
  }

  public cancelPairing() {
    console.log('Cancel pairing');
    this.stopDiscovery();
  }

  private stopDiscovery() {
    if (this.httpBrowser) {
      this.httpBrowser.stop();
      this.httpBrowser = undefined;
    }
  }
}
