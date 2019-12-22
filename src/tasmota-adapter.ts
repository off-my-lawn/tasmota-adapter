/**
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.*
 */

'use strict';

import { Adapter, Device, Property } from 'gateway-addon';
import fetch from 'node-fetch';
import { Browser, tcp } from 'dnssd';
import { isIPv4 } from 'net';

class OnOffProperty extends Property {
  private lastState?: boolean;

  constructor(private device: Device, private set: (value: boolean) => Promise<void>) {
    super(device, 'on', {
      '@type': 'OnOffProperty',
      type: 'boolean',
      title: 'On',
      description: 'Wether the device is on or off'
    });
  }

  async setValue(value: boolean) {
    try {
      console.log(`Set value of ${this.device.name} / ${this.title} to ${value}`);
      await super.setValue(value);
      this.set(value);
    } catch (e) {
      console.log(`Could not set value: ${e}`);
    }
  }

  update(value: boolean) {
    if (this.lastState != value) {
      this.lastState = value;
      this.setCachedValue(value);
      this.device.notifyPropertyChanged(this);
      console.log(`Value of ${this.device.name} / ${this.title} changed to ${value}`);
    }
  }
}

class Switch extends Device {
  private onOffProperty: OnOffProperty;

  constructor(adapter: Adapter, id: string, private host: string) {
    super(adapter, id);
    this['@context'] = 'https://iot.mozilla.org/schemas/';
    this['@type'] = ['SmartPlug'];
    this.name = id;

    this.onOffProperty = new OnOffProperty(this, async value => {
      const status = value ? 'ON' : 'OFF';
      const result = await fetch(`http://${host}/cm?cmnd=Power0%20${status}`);

      if (result.status != 200) {
        console.log('Could not set status');
      }
    });

    this.addProperty(this.onOffProperty);
  }

  addProperty(property: Property) {
    this.properties.set(property.name, property);
  }

  public startPolling(intervalMs: number) {
    setInterval(() => this.poll(), intervalMs);
  }

  public async poll() {
    const response = await fetch(`http://${this.host}/cm?cmnd=Power`);
    const result = await response.json();
    const value = result.POWER == 'ON';
    this.onOffProperty.update(value);
  }
}

export class TasmotaAdapter extends Adapter {
  private httpBrowser?: Browser;
  private devices: { [key: string]: Switch } = {};

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
      pollInterval
    } = this.manifest.moziot.config;

    const url = `${host}:${port}`;

    console.log(`Probing ${url}`);

    const result = await fetch(`http://${url}`);

    if (result.status == 200) {
      const body = await result.text();

      if (body.indexOf('Tasmota') >= 0) {
        console.log(`Discovered Tasmota at ${name}`);
        let device = this.devices[name];

        if (!device) {
          device = new Switch(this, name, host);
          this.devices[name] = device;
          this.handleDeviceAdded(device);
          device.startPolling(Math.max(pollInterval || 1000, 500));
        }
      } else {
        console.log(`${name} seems not to be a Tasmota device`);
      }
    } else {
      console.log(`${name} responded with ${result.status}`);
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