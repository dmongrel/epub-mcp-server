# epub-novel-mcp-server

An [MCP](https://modelcontextprotocol.io/) server for creating and editing EPUB
novels, built on the official Go SDK
(`github.com/modelcontextprotocol/go-sdk`). It exposes tools for reading and
writing an EPUB's metadata, chapters, navigation, cover, and resources.

The server runs over **Streamable HTTP** and listens on **`0.0.0.0:8383`**. MCP
clients connect to the running server at `http://127.0.0.1:8383`; the process is
**not** spawned per-connection over stdio — it runs independently, either in the
foreground or as a managed background service.

## Prerequisites

- [Go 1.26](https://go.dev/dl/) or newer.

## Build

```sh
# Linux / macOS
go build -o epub-novel-mcp-server .

# Windows (PowerShell)
go build -o epub-novel-mcp-server.exe .
```

This produces a single self-contained binary.

## Run from the command line

Run the binary with no arguments to start the server in the foreground:

```sh
./epub-novel-mcp-server
# → epub-novel-mcp-server listening on http://0.0.0.0:8383
```

Press `Ctrl-C` to stop it. This is the simplest way to run the server for local
use or development.

## Install as a background service

The binary can install itself as a native service on Windows, Linux, and macOS
(via `github.com/kardianos/service`). The same subcommands work on every
platform:

| Command                              | Effect                                             |
| ------------------------------------ | -------------------------------------------------- |
| `epub-novel-mcp-server install`      | Register the service with the OS service manager   |
| `epub-novel-mcp-server start`        | Start the installed service                        |
| `epub-novel-mcp-server stop`         | Stop the running service                           |
| `epub-novel-mcp-server restart`      | Restart the service                                |
| `epub-novel-mcp-server uninstall`    | Remove the service registration                    |

Installing/managing a system service requires elevated privileges on every
platform.

### Windows (Windows Service)

Run from an **Administrator** PowerShell / Command Prompt:

```powershell
.\epub-novel-mcp-server.exe install
.\epub-novel-mcp-server.exe start
```

The service appears in **Services** (`services.msc`) as *EPUB Novel MCP Server*
and starts automatically on boot. Manage it there or with `sc.exe` as well.

```powershell
.\epub-novel-mcp-server.exe stop
.\epub-novel-mcp-server.exe uninstall
```

### Linux (systemd)

Run with `sudo` (installs a systemd unit):

```sh
sudo ./epub-novel-mcp-server install
sudo ./epub-novel-mcp-server start
```

Then manage it through systemd if you prefer:

```sh
sudo systemctl status epub-novel-mcp-server
sudo systemctl enable epub-novel-mcp-server   # start on boot
journalctl -u epub-novel-mcp-server -f        # follow logs
```

Uninstall:

```sh
sudo ./epub-novel-mcp-server stop
sudo ./epub-novel-mcp-server uninstall
```

### macOS (launchd)

Run with `sudo` (installs a launchd daemon):

```sh
sudo ./epub-novel-mcp-server install
sudo ./epub-novel-mcp-server start
```

Uninstall:

```sh
sudo ./epub-novel-mcp-server stop
sudo ./epub-novel-mcp-server uninstall
```

## Connect an MCP client

Point your MCP client at the running server's HTTP endpoint. For a Claude-style
`.mcp.json`:

```json
{
    "mcpServers": {
        "epub-novel-mcp-server": {
            "type": "http",
            "url": "http://127.0.0.1:8383"
        }
    }
}
```

The server must already be running (foreground or as a service) before the
client connects — an `http` transport does not launch the process itself. If
starting the server reports that the port is already in use, it is most likely
already running; just connect to the existing endpoint.

## Configuration & security notes

- **Address:** the server binds `0.0.0.0:8383`, so it is reachable both on
  loopback (`127.0.0.1`) and from other machines on the LAN at the host's IP.
- **DNS-rebinding protection:** the SDK rejects (403) requests that arrive over a
  localhost address but carry a non-localhost `Host` header. Normal
  `127.0.0.1:8383` and LAN-IP access are unaffected.
- Intended for local / trusted-network, single-user use.
