# SQLBox for Kamex, rebuilt from the official checksum-pinned 1.8.3 source RPM
# with the MSSQL dispatcher branch disabled.
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
    && grep -c '#if 0' gw/sqlbox_sql.c \
    && autoreconf -fi \
    && ./configure --prefix=/usr --with-kannel-dir=/usr \
    && make -j"$(nproc)" \
    && install -m 755 gw/sqlbox /sqlbox-nomssql

FROM ghcr.io/vaska94/kamex:1.8.3@sha256:c13f0e390bf0cbadef55440a6dc584670851faf41e42a027644e984502a21d7d

USER 0
COPY --from=builder /sqlbox-nomssql /usr/sbin/sqlbox
COPY entrypoint.sh /usr/local/bin/sqlbox-entrypoint.sh
RUN chmod 755 /usr/local/bin/sqlbox-entrypoint.sh /usr/sbin/sqlbox

USER kamex
ENTRYPOINT ["/usr/local/bin/sqlbox-entrypoint.sh"]
