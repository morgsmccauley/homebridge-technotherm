import { API, DynamicPlatformPlugin, Logger, PlatformAccessory, PlatformConfig, Service, Characteristic } from 'homebridge';
import { HelkiClient } from './helki_client';

import { PLATFORM_NAME, PLUGIN_NAME } from './settings';
import { Radiator } from './radiator';

/**
 * Technotherm
 * This class is the main constructor for your plugin, this is where you should
 * parse the user config and discover/register accessories with Homebridge.
 */
export class Technotherm implements DynamicPlatformPlugin {
  public readonly Service: typeof Service = this.api.hap.Service;
  public readonly Characteristic: typeof Characteristic = this.api.hap.Characteristic;

  // this is used to track restored cached accessories
  public readonly accessories: PlatformAccessory[] = [];

  constructor(
    public readonly log: Logger,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.log.debug('Finished initializing platform:', this.config.name);

    // When this event is fired it means Homebridge has restored all cached accessories from disk.
    // Dynamic Platform plugins should only register new accessories after this event was fired,
    // in order to ensure they weren't added to homebridge already. This event can also be used
    // to start discovery of new accessories.
    this.api.on('didFinishLaunching', () => {
      log.debug('Executed didFinishLaunching callback');
      // run the method to discover / register your devices as accessories
      this.discoverDevices();
    });
  }

  /**
   * This function is invoked when homebridge restores cached accessories from disk at startup.
   * It should be used to setup event handlers for characteristics and update respective values.
   */
  configureAccessory(accessory: PlatformAccessory) {
    this.log.info('Loading accessory from cache:', accessory.displayName);

    // add the restored accessory to the accessories cache so we can track if it has already been registered
    this.accessories.push(accessory);
  }

  /**
   * Authenticate with the API to obtain an access token and fetch the list of devices.
   */
  async discoverDevices() {
    try {
      const helki = new HelkiClient(
        this.config.apiName,
        this.config.clientId,
        this.config.clientSecret,
        this.config.username,
        this.config.password,
        this.log);

      const groups = await helki.getGroupedDevices();
      // Filter on home if specified
      const home = groups.find(home => home.name === this.config.home);

      for (const group of groups) {
        // Loop over the devices in the group
        // Sometimes a device contains a single radiator, sometimes multiple
        // Each radiator is a node in the Helki API
        for (const device of group.devs) {
          const nodes = await helki.getNodes(device.dev_id);

          if (nodes.length === 0) {
            this.log.warn(`No nodes found for device: ${device.name}`);
            continue;
          }

          // Devices can have multiple nodes, register an accessory for each
          for (const node of nodes) {
            // Use Node attributes for the accessory display name and UUID gen
            // but fallback to Device attributes in case they're undefined (i.e. Devices with a single node)
            const accessoryName = node.name || device.name;
            const accessoryUUID = this.api.hap.uuid.generate(node.uid || device.dev_id);
            const existingAccessory = this.accessories.find(accessory => accessory.UUID === accessoryUUID);

            if (existingAccessory) {
              // If the existing accessory is not in the configured home, remove it
              if (home && existingAccessory?.context.home !== home.name) {
                this.log.warn(`Removing accessory that does not match configured home "${home.name}: ${existingAccessory.displayName}"`);
                try {
                  this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [existingAccessory]);
                } catch (error: unknown) {
                  this.log.warn(`existing accessory: ${error}`);
                }
              } else {
                // If the node has been renamed, update the corresponding accessory
                if (existingAccessory.displayName !== accessoryName) {
                  this.log.info(`Renaming accessory from ${existingAccessory.displayName} to ${accessoryName}`);
                  existingAccessory.displayName = accessoryName;
                  this.api.updatePlatformAccessories([existingAccessory]);
                }

                // Accessory exists, restore from cache
                this.log.info('Restoring existing accessory from cache:', existingAccessory.displayName);
                new Radiator(this, existingAccessory, helki);
              }
            } else {
              // Accessory doesn't exist, add new
              const accessory = new this.api.platformAccessory(accessoryName, accessoryUUID);
              accessory.context.device = device;
              accessory.context.node = node;
              accessory.context.home = group.name;
              if (home !== undefined && home.name === group.name) {
                this.log.info('Adding new accessory:', accessoryName);
                new Radiator(this, accessory, helki);
                this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
              }
              if (home === undefined) {
                this.log.info('Adding new accessory:', accessoryName);
                new Radiator(this, accessory, helki);
                this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
              }
            }
          }
        }
      }

    } catch (error: unknown) {
      if (error instanceof Error) {
        this.log.error(`Failed to discover devices: ${error.message}`);
      } else {
        this.log.error(`Failed to discover devices: ${error}`);
      }
    }
  }

}
