import { Server } from 'socket.io';

type SocketRoomAdapter = {
    rooms?: Map<string, Set<string>>;
};

export function hasRoomMembers(server: Server, room: string): boolean {
    const adapter = getRoomAdapter(server);
    const roomMembers = adapter?.rooms?.get(room);

    return (roomMembers?.size ?? 0) > 0;
}

function getRoomAdapter(server: Server): SocketRoomAdapter | undefined {
    return (
        (server as unknown as { adapter?: SocketRoomAdapter }).adapter ??
        (server as unknown as { sockets?: { adapter?: SocketRoomAdapter } }).sockets
            ?.adapter
    );
}
