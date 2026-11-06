package main

import (
	"fmt"
	"net"
	"os"

	"golang.org/x/sys/unix"
)

type vsockAddr struct{ cid, port uint32 }

func (a vsockAddr) Network() string { return "vsock" }
func (a vsockAddr) String() string  { return fmt.Sprintf("%d:%d", a.cid, a.port) }

// vsockConn adapts a non-blocking vsock fd (poller-backed *os.File, so deadlines work) to net.Conn.
type vsockConn struct {
	*os.File
	local, remote vsockAddr
}

func (c *vsockConn) LocalAddr() net.Addr  { return c.local }
func (c *vsockConn) RemoteAddr() net.Addr { return c.remote }

type vsockListener struct {
	fd   int
	port uint32
}

func listenVsock(port uint32) (net.Listener, error) {
	fd, err := unix.Socket(unix.AF_VSOCK, unix.SOCK_STREAM|unix.SOCK_CLOEXEC, 0)
	if err != nil {
		return nil, err
	}
	if err := unix.Bind(fd, &unix.SockaddrVM{CID: unix.VMADDR_CID_ANY, Port: port}); err != nil {
		unix.Close(fd)
		return nil, err
	}
	if err := unix.Listen(fd, 4); err != nil {
		unix.Close(fd)
		return nil, err
	}
	return &vsockListener{fd: fd, port: port}, nil
}

func (l *vsockListener) Accept() (net.Conn, error) {
	for {
		nfd, sa, err := unix.Accept4(l.fd, unix.SOCK_CLOEXEC|unix.SOCK_NONBLOCK)
		if err == unix.EINTR {
			continue
		}
		if err != nil {
			return nil, err
		}
		// Only the host (CID 2) may talk to the agent.
		vm, ok := sa.(*unix.SockaddrVM)
		if !ok || vm.CID != unix.VMADDR_CID_HOST {
			unix.Close(nfd)
			continue
		}
		return &vsockConn{
			File:   os.NewFile(uintptr(nfd), "vsock"),
			local:  vsockAddr{cid: unix.VMADDR_CID_ANY, port: l.port},
			remote: vsockAddr{cid: vm.CID, port: vm.Port},
		}, nil
	}
}

func (l *vsockListener) Close() error   { return unix.Close(l.fd) }
func (l *vsockListener) Addr() net.Addr { return vsockAddr{cid: unix.VMADDR_CID_ANY, port: l.port} }
