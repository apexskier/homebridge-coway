<p align="center">

<img src="https://github.com/homebridge/branding/raw/latest/logos/homebridge-wordmark-logo-vertical.png" width="150">

</p>

# Homebridge Coway Airmega

This extension provides control for the [Coway Airmega 250S](https://cowaymega.com/products/airmega-250) air purifier. Other models may be supported as well.

Light settings are retained when fan speed, etc is changed, which Coway's IOCare app doesn't do.

## Unsupported

These features appear to be supported by the Coway API and Homebridge, but aren't populated for the 250S model.

- Humidity
- Temperature
- VOC density

I've intentionally not implemented a few features since they clutter the Home app or don't make sense.

- Light (switching between all on, AQI off, and all off)
- Outdoor AQI (this pulls from AirNow, a dedicated accessory would be better to split rooms, and be more efficient)

And a few things are implemented but not really working

- Filter Maintenance status
