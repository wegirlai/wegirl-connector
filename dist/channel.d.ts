declare const channelStates: Map<string, {
    running: boolean;
    connected: boolean;
    startedAt: number;
}>;
/**
 * 启动 channel（设置 running 状态）
 * 简化版本：不测试实际 Redis 连接，只设置状态
 */
declare function startChannel(accountId: string, log?: any): Promise<void>;
/**
 * 停止 channel
 */
declare function stopChannel(accountId: string, log?: any): Promise<void>;
declare const wegirlPlugin: {
    plugin: {
        id: string;
        meta: {
            label: string;
            selectionLabel: string;
            docsPath: string;
            blurb: string;
        };
        capabilities: {
            chatTypes: "direct"[];
            threads: boolean;
            polls: boolean;
            ephemeral: boolean;
        };
        config: {
            listAccountIds: (cfg: any) => string[];
            resolveAccount: (cfg: any, id: string | null) => {
                accountId: string;
                redisUrl: any;
                redisPassword: any;
                redisDb: any;
                redisHost: any;
                redisPort: any;
                channel: string;
                enabled: boolean;
                allowFrom: any[];
            };
            defaultAccountId: () => string;
            isEnabled: (account: any) => boolean;
            isConfigured: (account: any) => boolean;
            describeAccount: (e: any) => {
                accountId: any;
                enabled: boolean;
                configured: boolean;
                linked: boolean;
                running: boolean;
                connected: boolean;
            };
        };
        gateway: {
            /**
             * 启动 channel account（OpenClaw 调用）
             * 签名: (ctx: AccountContext) => Promise<void>
             * 注意：不返回 cleanup 函数，让 OpenClaw 通过 stopAccount 停止
             */
            startAccount(ctx: any): Promise<void>;
            /**
             * 停止 channel account（OpenClaw 调用）
             * 签名: (ctx: AccountContext) => Promise<void>
             */
            stopAccount(ctx: any): Promise<void>;
        };
    };
};
export { wegirlPlugin, channelStates, startChannel, stopChannel };
//# sourceMappingURL=channel.d.ts.map