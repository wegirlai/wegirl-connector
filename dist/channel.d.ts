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
    };
};
export { wegirlPlugin };
//# sourceMappingURL=channel.d.ts.map