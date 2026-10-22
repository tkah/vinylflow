"""One TCP connection to the in-container server, bridged over stdin/stdout (for docker exec -i)."""
import socket, sys, threading, os
s = socket.create_connection(("127.0.0.1", 8000))
def up():
    while True:
        d = os.read(0, 65536)
        if not d: break
        s.sendall(d)
    try: s.shutdown(socket.SHUT_WR)
    except OSError: pass
threading.Thread(target=up, daemon=True).start()
while True:
    d = s.recv(65536)
    if not d: break
    os.write(1, d)
