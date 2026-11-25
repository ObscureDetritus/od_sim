#!/usr/bin/env bash
# Sets up a fresh Ubuntu 24.04 server for the World Eater API. Run as root:  bash setup.sh
# Safe to run again (that is also how you update the API code).
#
# What it does, in order (no SSH key yet? password login stays on, guarded by fail2ban):
#   1. installs updates, and turns on automatic security updates
#   2. SSH: key login only (passwords off), but only if a key is already installed, so you can't get locked out
#   3. firewall: closes every port except 22 (SSH), 80 and 443 (web)
#   4. runs the API as its own locked-down user, listening only inside the server (127.0.0.1:8787)
#   5. Caddy in front of it: the only public web server, with an automatic HTTPS certificate
#
# Editing is open to everyone (rate-limited). To require a passphrase instead, put WORLD_KEY=... in
# /etc/worldeater.env (readable by root only) and restart, or run this with WORLD_KEY='...' set.
# Hourly backups of the world go to /var/backups/worldeater (kept 14 days).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
export DEBIAN_FRONTEND=noninteractive
say() { printf '\n== %s\n' "$*"; }

# ---------------------------------------------------------------- 1. updates
say "1/5 updates"
apt-get update -qq
apt-get upgrade -y -qq
apt-get install -y -qq python3 caddy ufw unattended-upgrades curl
dpkg-reconfigure -f noninteractive unattended-upgrades   # security fixes install themselves daily

# ---------------------------------------------------------------- 2. ssh
say "2/5 ssh"
if [ -s /root/.ssh/authorized_keys ]; then
  cat > /etc/ssh/sshd_config.d/10-hardening.conf <<'CONF'
# keys only: no password guessing possible
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
CONF
  sshd -t && systemctl reload ssh
  echo "password login disabled; key login only"
else
  # no key yet: passwords must keep working, so ban addresses that keep guessing (5 misses = 1 hour)
  apt-get install -y -qq fail2ban
  cat > /etc/fail2ban/jail.d/sshd.local <<'CONF'
[sshd]
enabled = true
maxretry = 5
bantime = 1h
CONF
  systemctl enable fail2ban >/dev/null 2>&1; systemctl restart fail2ban
  echo "No SSH key installed: password login stays ON, guarded by fail2ban. Use a long root password."
fi

# ---------------------------------------------------------------- 3. firewall
say "3/5 firewall"
ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
ufw allow 22/tcp >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw --force enable
ufw status | sed -n '1,12p'

# ---------------------------------------------------------------- 4. the API
say "4/5 World Eater API"
if [ -z "${WORLD_KEY+x}" ]; then   # not given: keep whatever the server already has (empty = open editing)
  WORLD_KEY="$(grep -s '^WORLD_KEY=' /etc/worldeater.env | cut -d= -f2- || true)"
fi
id worldeater >/dev/null 2>&1 || useradd --system --home /opt/worldeater --shell /usr/sbin/nologin worldeater
install -d -o root -g root -m 755 /opt/worldeater
install -d -o worldeater -g worldeater -m 700 /opt/worldeater/data
install -o root -g root -m 644 "$here/../worldeater_api.py" /opt/worldeater/worldeater_api.py   # the app can't rewrite its own code
( umask 077; cat > /etc/worldeater.env <<ENV
WORLD_KEY=$WORLD_KEY
WORLD_DATA=/opt/worldeater/data/world.json
WORLD_ORIGINS=https://od.declino.systems,http://od.declino.systems
ENV
)
install -m 644 "$here/worldeater.service" /etc/systemd/system/worldeater.service
install -m 755 "$here/worldeater-backup" /etc/cron.hourly/worldeater-backup
systemctl daemon-reload
systemctl enable worldeater >/dev/null 2>&1
systemctl restart worldeater

# ---------------------------------------------------------------- 5. caddy
say "5/5 Caddy (HTTPS)"
if ! grep -q 'api.declino.systems' /etc/caddy/Caddyfile 2>/dev/null; then
  if grep -q '/usr/share/caddy' /etc/caddy/Caddyfile 2>/dev/null || [ ! -s /etc/caddy/Caddyfile ]; then
    install -m 644 "$here/Caddyfile" /etc/caddy/Caddyfile        # replace the stock welcome page
  else
    cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.bak                # keep other sites, add ours
    printf '\n' >> /etc/caddy/Caddyfile; cat "$here/Caddyfile" >> /etc/caddy/Caddyfile
  fi
fi
systemctl enable caddy >/dev/null 2>&1
systemctl restart caddy

sleep 2
say "check"
curl -fsS http://127.0.0.1:8787/health && echo
echo "Public address: https://api.declino.systems/health  (HTTPS works once the api DNS record points here)"
echo "Editing: $( [ -n "$WORLD_KEY" ] && echo 'needs the passphrase in /etc/worldeater.env' || echo 'open to everyone, rate-limited')"
