interface SessionsSendOptions {
    message: string;
    cfg: any;
    channel: string;
    accountId: string;
    from: string;
    chatId: string;
    chatType: string;
    log?: any;
}
/**
 * 使用 PluginRuntime 发送消息
 */
export declare function wegirlSessionsSend(options: SessionsSendOptions): Promise<void>;
export {};
//# sourceMappingURL=sessions-send.d.ts.map