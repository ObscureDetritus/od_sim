# World Eater API

Keeps one shared world (heading, intro, numbered facts) that every visitor to World Eater sees.
Anyone can read it; editing needs the passphrase set in `WORLD_KEY`.
Python standard library only, one file: `worldeater_api.py`.

- Read by agents: `https://api.declino.systems/world.md`
- Used by the page: `GET /world`, `POST /world/ops` (see the top of `worldeater_api.py`)

## Run locally

Start the "world-api" preview (or `python3 server/worldeater_api.py`).
World Eater on `localhost:8000` talks to `127.0.0.1:8787` automatically.

## Deploy on Contabo

1. In Spaceship DNS for declino.systems add an **A** record: host `api`, value = the server's IP.
2. Copy this folder to the server and run the setup once as root:

```bash
scp -r server root@SERVER_IP:/root/worldeater
ssh root@SERVER_IP "bash /root/worldeater/deploy/setup.sh"
```

It installs Caddy (HTTPS) and a `worldeater` service and stores the world in
`/opt/worldeater/data/world.json`. To restore a backup:

```bash
ssh root@SERVER_IP "cp /var/backups/worldeater/world-YYYY-MM-DD_HH00.json /opt/worldeater/data/world.json && systemctl restart worldeater"
```

To update the code later: copy `worldeater_api.py` to `/opt/worldeater/` and restart the service.
