#!/usr/bin/env bash
# One-time move of a running host from the old layout (/opt/zerostress, /opt/zerostress-src, /etc/zerostress,
# /var/lib/zerostress*, /etc/caddy, /usr/local/bin/caddy, /opt/node, /opt/go) to the single project directory
# /zerostress (spec 010). Run as root from /zerostress, after: mv /opt/zerostress-src /zerostress
#
#   deploy/migrate-from-opt.sh prepare    no downtime: directories, settings copied from /etc/zerostress, runtime,
#                                         the guest image, builds, a first copy of the data
#   deploy/migrate-from-opt.sh switch     about a minute of downtime: stop, copy the data again, install the new units
#                                         and sudoers rules, start, verify; on any failure the old units come back
#   deploy/migrate-from-opt.sh rollback   put the old units and sudoers rules back and start the old services
#   deploy/migrate-from-opt.sh cleanup    after the new layout has run for a while: remove the old places
#
# Nothing old is deleted before `cleanup`.
source "$(dirname "$0")/lib.sh"
need_root
need_root_dir
BACKUP=$S/build/migrate-backup
OLD_UNITS=(/etc/systemd/system/zerostress-supervisor.service /etc/systemd/system/zerostress-web.service /etc/systemd/system/caddy.service /etc/sudoers.d/zerostress-vm /etc/sudoers.d/zerostress-net)

copy_data() {
  rsync -a --delete /var/lib/zerostress-web/tasks/ "$S/data/web/tasks/"
  rsync -a /var/lib/zerostress-web/geo/ "$S/data/geo/"
  rsync -a /var/lib/caddy/ "$S/data/caddy/"
  rsync -a --exclude runs --exclude '.*' /var/lib/zerostress/ "$S/data/supervisor/"
  chown -R zerostress-web:zerostress-web "$S/data/web" "$S/data/geo"
  chown -R caddy:caddy "$S/data/caddy"
  chown -R zerostress-sup:zerostress-sup "$S/data/supervisor"
  restorecon -R "$S/data"
}

rollback() {
  echo "== rollback: the old units and sudoers rules come back"
  systemctl stop caddy zerostress-web zerostress-supervisor 2>/dev/null || true
  for f in "${OLD_UNITS[@]}"; do [[ -f $BACKUP$f ]] && install -m "$(stat -c %a "$BACKUP$f")" "$BACKUP$f" "$f"; done
  systemctl daemon-reload
  systemctl start zerostress-supervisor zerostress-web caddy
  systemctl --no-pager --lines=0 status zerostress-supervisor zerostress-web caddy | grep -E '^●|Active:' || true
}

case ${1:-} in
  prepare)
    [[ -d /opt/zerostress ]] || { echo "no old layout at /opt/zerostress" >&2; exit 1; }
    install -d -m 0755 "$S/config"
    # the settings as they are now; the dead AGENT_MODE (read by nothing) is left behind
    for e in web supervisor; do
      if [[ ! -e $S/config/$e.env && -e /etc/zerostress/$e.env ]]; then
        grep -v '^AGENT_MODE=\|^# auto | vision' "/etc/zerostress/$e.env" >"$S/config/$e.env"
        chown root:"zerostress-${e/supervisor/sup}" "$S/config/$e.env"; chmod 0640 "$S/config/$e.env"
      fi
    done
    bash "$S/deploy/steps/10-host.sh"
    bash "$S/deploy/steps/30-runtime.sh"
    for f in /opt/zerostress/images/*; do cp --sparse=always -p "$f" "$S/images/"; done
    chown -R root:root "$S/images"; restorecon -R "$S/images"
    as_builder bash "$S/supervisor/build.sh" | tail -1
    as_builder bash -c "cd '$S/web' && npm ci --ignore-scripts --no-audit --no-fund >/dev/null"
    as_builder bash -c "cd '$S/web/client' && npm ci --ignore-scripts --no-audit --no-fund >/dev/null && npx vite build >/dev/null"
    copy_data
    echo "prepared; the old services still run. Next: $0 switch"
    ;;
  switch)
    [[ -x $S/runtime/node/bin/node && -s $S/images/guest-rootfs.ext4 ]] || { echo "run $0 prepare first" >&2; exit 1; }
    install -d -m 0700 "$BACKUP"
    for f in "${OLD_UNITS[@]}"; do [[ -f $f ]] && install -D -m "$(stat -c %a "$f")" "$f" "$BACKUP$f"; done
    trap 'echo "switch failed"; rollback; exit 1' ERR
    echo "== stopping the old services"
    systemctl stop caddy zerostress-web zerostress-supervisor
    copy_data
    bash "$S/deploy/steps/20-network.sh"
    bash "$S/deploy/steps/50-supervisor.sh"
    bash "$S/deploy/steps/60-web.sh"
    trap - ERR
    bash "$S/deploy/steps/90-verify.sh" || { echo "verify found problems: look above; '$0 rollback' brings the old layout back"; exit 1; }
    echo "switched. When it has run fine for a while: $0 cleanup"
    ;;
  rollback) rollback ;;
  cleanup)
    for u in zerostress-supervisor zerostress-web caddy; do
      systemctl is-active --quiet "$u" || { echo "$u is not running: not cleaning up" >&2; exit 1; }
    done
    semanage fcontext -d '/opt/zerostress/bin(/.*)?' 2>/dev/null || true
    rm -rf /opt/zerostress /etc/zerostress /var/lib/zerostress-web /etc/caddy /var/lib/caddy /opt/node /opt/go /usr/local/bin/caddy /etc/tmpfiles.d/zerostress.conf
    rm -rf /var/lib/zerostress
    # usermod refuses while the supervisor runs as this user; the stale home field is harmless (the directory is gone)
    usermod -d /nonexistent zerostress-sup 2>/dev/null ||
      echo "zerostress-sup is busy: its home stays /var/lib/zerostress until 'usermod -d /nonexistent zerostress-sup' with the supervisor stopped"
    rm -rf "$BACKUP" /var/tmp/zerostress-build
    echo "old layout removed"
    ;;
  *) sed -n '2,13s/^# \{0,1\}//p' "$0"; exit 1 ;;
esac
