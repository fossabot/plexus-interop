

export class UrlResolver {

    public getProxyHostUrl(baseUrl: string): string {
        return `${baseUrl}/proxyHost.html`;
    }    

    public getInteropMetadataUrl(baseUrl: string): string {
        return `${baseUrl}/interop.json`;
    } 

    public getAppMetadataUrl(baseUrl: string): string {
        return `${baseUrl}/apps.json`;
    }

}