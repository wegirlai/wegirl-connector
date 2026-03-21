export declare const wegirlPlugin: {
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
                channel: string;
                enabled: boolean;
            };
            defaultAccountId: () => string;
            isEnabled: (account: any) => boolean;
            isConfigured: (account: any) => boolean;
            describeAccount: (e: any) => {
                accountId: any;
                enabled: boolean;
                configured: boolean;
                linked: boolean;
            };
        };
        outbound: {
            deliveryMode: "direct";
            sendText: ({ text, to, from, accountId, sessionId }: any, log?: any) => Promise<{
                ok: boolean;
                error?: undefined;
            } | {
                ok: boolean;
                error: any;
            }>;
        };
        gateway: {
            startAccount: (ctx: any) => Promise<void>;
        };
    };
};
//# sourceMappingURL=channel.d.ts.map