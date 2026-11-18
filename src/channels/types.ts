export interface ChannelMessage {
  agentName: string;
  message: string;
  userId?: string;
  channelId: string;
}

export interface ChannelHandler {
  handleMessage(msg: ChannelMessage): Promise<ChannelResponse>;
}

export interface ChannelResponse {
  text: string;
  channelId: string;
}
