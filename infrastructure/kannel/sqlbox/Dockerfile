# SQLBox for Kamex, rebuilt from the official checksum-pinned 1.8.3 source RPM
# with the MSSQL dispatcher branch disabled and the PostgreSQL driver taught the
# `priority` column its MySQL sibling already carries.
#
# Why not the official binary RPM: upstream sqlbox's backend dispatcher calls
# sqlbox_init_mssql first when compiled with FreeTDS support, and that function
# panics ("MSSql: connection settings ... are not specified") for ANY
# configuration without an mssql-connection group — which makes the official
# build unusable with PostgreSQL. See SYSTEM_IMPROVEMENT_PROPOSALS.md.
#
# The builder is AlmaLinux 10 (binary-compatible with the RHEL 10 runtime
# image, which is a minimal image without build tooling or full repos).
FROM almalinux:10 AS builder

ARG SQLBOX_SRC_RPM_URL=https://github.com/vaska94/Kamex/releases/download/v1.8.3/kamex-sqlbox-1.8.3-1.el10.src.rpm
ARG SQLBOX_SRC_RPM_SHA256=5827de835a0cc9361217a2f8ab152d157a37ce9d03fbfc87128b357f70ca8967
ARG KAMEX_DEVEL_RPM_URL=https://github.com/vaska94/Kamex/releases/download/v1.8.3/kamex-devel-1.8.3-1.el10.x86_64.rpm
ARG KAMEX_DEVEL_RPM_SHA256=434719c4427eb7ccebb4ccf4c21f35216d076ed9277ffd8351cf7c5af044f4ca
ARG KAMEX_RPM_URL=https://github.com/vaska94/Kamex/releases/download/v1.8.3/kamex-1.8.3-1.el10.x86_64.rpm

RUN dnf install -y epel-release \
    && dnf install -y --setopt=install_weak_deps=False \
        gcc make cpio tar gzip autoconf automake libtool pkgconfig \
        libxml2-devel openssl-devel zlib-devel \
        libpq-devel mariadb-connector-c-devel mariadb-devel sqlite-devel \
        libsqlite3x-devel hiredis-devel freetds-devel \
        redhat-rpm-config annobin-plugin-gcc gcc-plugin-annobin \
    && dnf clean all

# The gateway package provides libgwlib/libwap needed at link time; devel
# provides headers and gw-config.h.
RUN curl --fail --location "${KAMEX_RPM_URL}" --output /tmp/kamex.rpm \
    && curl --fail --location "${KAMEX_DEVEL_RPM_URL}" --output /tmp/kamex-devel.rpm \
    && echo "${KAMEX_DEVEL_RPM_SHA256}  /tmp/kamex-devel.rpm" | sha256sum --check --strict \
    && rpm -Uvh --nodeps /tmp/kamex.rpm /tmp/kamex-devel.rpm

RUN curl --fail --location "${SQLBOX_SRC_RPM_URL}" --output /tmp/sqlbox.src.rpm \
    && echo "${SQLBOX_SRC_RPM_SHA256}  /tmp/sqlbox.src.rpm" | sha256sum --check --strict \
    && mkdir -p /build && cd /build \
    && rpm2cpio /tmp/sqlbox.src.rpm | cpio -idm \
    && tar xzf ./*.tar.gz

# Keep only the PostgreSQL dispatcher branch: every upstream sqlbox_init_*
# panics instead of returning NULL when its *-connection group is absent, so
# a multi-backend build can never reach the PostgreSQL branch. JKANNEL is
# PostgreSQL-only by architecture (SQLBox tables live in the platform's
# PostgreSQL). Build recipe otherwise mirrors kamex-sqlbox.spec (%build).
RUN cd /build/kamex-1.8.3/addons/sqlbox \
    && sed -i \
         -e 's/#ifdef HAVE_MSSQL/#if 0 \/* disabled: panics when its group is absent *\//' \
         -e 's/#ifdef HAVE_MYSQL/#if 0 \/* disabled: panics when its group is absent *\//' \
         -e 's/#ifdef HAVE_ORACLE/#if 0 \/* disabled: panics when its group is absent *\//' \
         -e 's/#ifdef HAVE_SQLITE3/#if 0 \/* disabled: panics when its group is absent *\//' \
         gw/sqlbox_sql.c \
    && test "$(grep -c '#if 0' gw/sqlbox_sql.c)" -eq 4

# -----------------------------------------------------------------------------
# PRIORITY PARITY PATCH — teach the PostgreSQL driver the `priority` column that
# the MySQL driver in the SAME source tree already carries.
#
# WHY THIS EXISTS. bearerbox genuinely honours message priority: the per-SMSC
# queue is gw_prioqueue_create(sms_priority_compare) (gw/smsc/smsc_smpp.c:246),
# a MAX-heap on sms.priority then sms.time (gw/sms.c:395), and
# smsc_smpp.c:1154 puts the value on the wire as submit_sm.priority_flag.
# What breaks the chain is the SQLBox driver, not the engine:
#
#   gw/sqlbox_mysql.h   CREATE / SELECT / INSERT all name `priority`, and
#                       sqlbox_mysql.c:148 does atol_null(row[27])
#   gw/sqlbox_pgsql.h   SELECT names 27 columns and `priority` is not one of
#                       them; the string appears nowhere in sqlbox_pgsql.c
#
# So on stock PostgreSQL every row read out of send_sms reaches bearerbox with
# msg->sms.priority still MSG_PARAM_UNDEFINED (-1). Every message carries the
# same value, the max-heap degenerates to its sms.time tiebreak, and the queue
# is FIFO purely by accident of uniformity. Adding a `priority` column to
# send_sms WITHOUT this patch would be read by nothing: sqlbox's SELECT is a
# fixed string in a compiled binary, and a column it does not name is invisible.
#
# WHAT IT DOES — five substitutions, mirroring sqlbox_mysql.{c,h} exactly:
#   1. both CREATE TABLE statements gain `priority BIGINT NULL` immediately
#      before foreign_id, the same position the MySQL driver puts it in
#   2. SELECT gains `priority` as its 28th column, i.e. result index 27
#   3. INSERT gains the `priority` column plus one more %S placeholder.
#      octstr_format's %S are positional and interchangeable, so the extra
#      placeholder is appended to the first VALUES line; what matters is that
#      the placeholder count matches the column count, which is asserted below.
#   4. pgsql_save_msg() writes st_num(msg->sms.priority), so sent_sms records
#      what a message was actually sent at
#   5. pgsql_fetch_msg() reads it back with atol_null(27). A NULL column yields
#      -1 = MSG_PARAM_UNDEFINED, i.e. exactly today's behaviour for any row that
#      does not set a priority — the default path is unchanged.
#
# IDEMPOTENT. Every substitution consumes its own pattern. The one insertion
# with no naturally consumed anchor (case 5) also normalises `meta_data  =` to
# `meta_data =`; that whitespace change is what stops a re-run duplicating the
# line, not cosmetics.
#
# ASSERTED. A sed that matches nothing exits 0, which would produce an
# unpatched binary that looks patched — the only real risk in this file. Each
# `grep`/`test` below turns that into a build failure. The last one greps the
# LINKED BINARY, because a compiled string is the only proof the build actually
# consumed the patched source.
#
# foreign_id is deliberately untouched: sqlbox_pgsql.c stamps the consumed
# send_sms.sql_id into it ("we abuse the foreign_id field in the message struct
# for our sql_id value"), and that is JKANNEL's correlation key for tracing,
# resend and DLR-derived delivery status.
#
# NOTE FOR OPERATORS: sqlbox's CREATE TABLE has no IF NOT EXISTS, so on an
# existing database these CREATEs fail harmlessly and the column is NOT added.
# database/migrations/043_send_sms_priority.up.sql adds it to send_sms and
# sent_sms for already-deployed installations.
# -----------------------------------------------------------------------------
RUN cd /build/kamex-1.8.3/addons/sqlbox \
    && sed -i \
         -e 's/meta_data TEXT NULL, foreign_id VARCHAR(255) NULL)/meta_data TEXT NULL, priority BIGINT NULL, foreign_id VARCHAR(255) NULL)/g' \
         -e 's/binfo, meta_data FROM %S/binfo, meta_data, priority FROM %S/' \
         -e 's/binfo, meta_data, foreign_id) VALUES (%S, %S, %S,/binfo, meta_data, priority, foreign_id) VALUES (%S, %S, %S, %S,/' \
         gw/sqlbox_pgsql.h \
    && sed -i \
         -e 's/st_str(msg->sms.meta_data), st_str(msg->sms.foreign_id));/st_str(msg->sms.meta_data), st_num(msg->sms.priority), st_str(msg->sms.foreign_id));/' \
         -e 's/msg->sms.meta_data  = octstr_null_create(26);/msg->sms.meta_data = octstr_null_create(26);\n            msg->sms.priority = atol_null(27);/' \
         gw/sqlbox_pgsql.c \
    && test "$(grep -c 'priority BIGINT NULL' gw/sqlbox_pgsql.h)" -eq 2 \
    && grep -q 'binfo, meta_data, priority FROM %S' gw/sqlbox_pgsql.h \
    && grep -q 'binfo, meta_data, priority, foreign_id) VALUES' gw/sqlbox_pgsql.h \
    && test "$(sed -n '/SQLBOX_PGSQL_INSERT_QUERY/,+3p' gw/sqlbox_pgsql.h | grep -o '%S' | wc -l)" -eq 28 \
    && grep -q 'st_num(msg->sms.priority)' gw/sqlbox_pgsql.c \
    && grep -q 'msg->sms.priority = atol_null(27);' gw/sqlbox_pgsql.c

RUN cd /build/kamex-1.8.3/addons/sqlbox \
    && autoreconf -fi \
    && ./configure --prefix=/usr --with-kannel-dir=/usr \
    && make -j"$(nproc)" \
    && grep -qa 'binfo, meta_data, priority FROM' gw/sqlbox \
    && install -m 755 gw/sqlbox /sqlbox-nomssql

FROM ghcr.io/vaska94/kamex:1.8.3@sha256:c13f0e390bf0cbadef55440a6dc584670851faf41e42a027644e984502a21d7d

USER 0
COPY --from=builder /sqlbox-nomssql /usr/sbin/sqlbox
COPY entrypoint.sh /usr/local/bin/sqlbox-entrypoint.sh
RUN chmod 755 /usr/local/bin/sqlbox-entrypoint.sh /usr/sbin/sqlbox

USER kamex
ENTRYPOINT ["/usr/local/bin/sqlbox-entrypoint.sh"]
