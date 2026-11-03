# HomeHub

HomeHub is a free smart home hub that runs on your own hardware, such as a Raspberry Pi. It controls your plugs and lights over your home network, with no HomeHub account.

## What it does

- Controls TP-Link Kasa, Shelly, Tuya and Meross devices from one dashboard
- Shows Wyze cameras live and saves a snapshot when one sees motion
- Runs schedules, including sunrise and sunset
- Runs scenes that set several devices at once
- Turns lights on with motion and off when a room is empty
- Takes plain-language commands in Chat, such as "turn on the porch light for an hour"
- Tracks energy use on supported devices
- Connects to AI assistants through MCP

## Get started

On a Raspberry Pi or other 64-bit Linux computer, run:

```bash
curl -fsSL https://raw.githubusercontent.com/foodisready/homehub/main/scripts/install.sh | sh
```

Then open `http://homehub.local:4200` and create your account.

- **[Install HomeHub](docs/INSTALL.md):** set up Docker and get HomeHub running
- **[User Guide](docs/USER_GUIDE.md):** add devices and use each feature
- **[Remote Access](docs/REMOTE_ACCESS.md):** reach HomeHub away from home

## Support HomeHub

HomeHub is free, and always will be. If it's useful to you, you can support its development with a donation.

**[Donate to HomeHub](https://buy.stripe.com/aFabIUfbD70fgk7fmY2B200)** (any amount from $2, paid securely through Stripe)

- Donations are voluntary, final, and not tax-deductible. They don't buy a product, service or features. Everyone gets the same HomeHub.
- They pay for development time and the smart devices HomeHub is tested with.
- Your card statement shows **HOMEHUB DONATION**. Donations are received by Super Future Funk LLC.
- If you were charged by mistake, charged twice, or charged the wrong amount, [open an issue](https://github.com/foodisready/homehub/issues) within 30 days and we'll refund it.

## Contact

For questions, bug reports and donation problems, [open an issue on GitHub](https://github.com/foodisready/homehub/issues).

## For developers

- [Getting Started](docs/GETTING_STARTED.md) covers local development
- [Architecture](docs/ARCHITECTURE.md) describes the system design
- [API reference](docs/API_SPEC.md) lists the REST API
- [Voice control plan](docs/VOICE_CONTROL.md) covers the voice work in progress

## License

Copyright © 2026 foodisready.

HomeHub is free software, licensed under the [GNU Affero General Public License, version 3](LICENSE) (AGPL-3.0-only).

- You can use HomeHub for any purpose, including at home or in a business, and change it however you like.
- If you share a changed version, or let other people use a changed version over a network, you must make your source code available to them under the same licence.
