# The container of scripts/mutation-sandbox.sh: Node, the pinned Rust toolchain for the pi-peers
# gateway, tmux for the pi-scrollback journey and Python for the end-to-end helpers.
FROM rust:1.98.0-slim-bookworm@sha256:1469a27c125cb5a3aebfa4f4e4665d935b02fb72cc093b2c974b3d740e43f157 AS rust

FROM node:26-bookworm@sha256:0a7c0471c10988ef5ab64718fa58bf8d5be578b4d20cf42b10b5fa6ccda39ae1
COPY --from=rust /usr/local/cargo /usr/local/cargo
COPY --from=rust /usr/local/rustup /usr/local/rustup
ENV RUSTUP_HOME=/usr/local/rustup \
    CARGO_HOME=/usr/local/cargo \
    PATH=/usr/local/cargo/bin:$PATH \
    CARGO_BUILD_JOBS=4 \
    CI=true
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 rsync tmux \
  && rm -rf /var/lib/apt/lists/*
RUN git config --global user.email sandbox@localhost \
  && git config --global user.name sandbox \
  && git config --global init.defaultBranch main
WORKDIR /sandbox
