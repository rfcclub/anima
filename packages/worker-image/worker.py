#!/usr/bin/env python3
"""Relay loopback model requests over the VM's published Unix socket."""
import os
import queue
import shutil
import socket
import subprocess
import sys
import threading

SOCKET = "/run/anima/gw.sock"
connections = queue.Queue()


def copy(source, target):
    try:
        while True:
            data = source.recv(65536)
            if not data:
                break
            target.sendall(data)
    except OSError:
        pass
    finally:
        try:
            target.shutdown(socket.SHUT_WR)
        except OSError:
            pass


def pair(client):
    upstream = connections.get()
    left = threading.Thread(target=copy, args=(client, upstream), daemon=True)
    right = threading.Thread(target=copy, args=(upstream, client), daemon=True)
    left.start()
    right.start()
    left.join()
    right.join()
    client.close()
    upstream.close()


def accept_upstreams(server):
    while True:
        try:
            connections.put(server.accept()[0])
        except OSError:
            return


def accept_clients(server):
    while True:
        try:
            threading.Thread(target=pair, args=(server.accept()[0],), daemon=True).start()
        except OSError:
            return


def main():
    os.makedirs(os.path.dirname(SOCKET), exist_ok=True)
    unix = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    unix.bind(SOCKET)
    unix.listen(32)
    tcp = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    tcp.bind(("127.0.0.1", 8787))
    tcp.listen(32)
    threading.Thread(target=accept_upstreams, args=(unix,), daemon=True).start()
    threading.Thread(target=accept_clients, args=(tcp,), daemon=True).start()
    # The host must not connect to the published socket until this listener exists.
    with open(os.path.join(os.environ["HOME"], ".relay-ready"), "x", encoding="utf-8") as marker:
        marker.write("ready\n")
    if not shutil.which("low"):
        return 127
    return subprocess.run(["low", *sys.argv[1:]], check=False).returncode


if __name__ == "__main__":
    sys.exit(main())
