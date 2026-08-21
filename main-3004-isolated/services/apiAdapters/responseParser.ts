export interface ParsedImageResponse {
    images: string[];
    originalResponse: any;
}

export class OpenAIResponseParser {
    static parseImageResponse(data: any): ParsedImageResponse {
        const images: string[] = [];

        if (data?.data && Array.isArray(data.data)) {
            for (const item of data.data) {
                if (item?.b64_json) {
                    images.push(`data:image/png;base64,${item.b64_json}`);
                } else if (item?.url) {
                    images.push(item.url);
                }
            }
            if (images.length > 0) {
                return { images, originalResponse: data };
            }
        }

        const message = data?.choices?.[0]?.message;
        const content = message?.content;
        if (typeof content === 'string' && content.trim()) {
            const extracted = this.extractImagesFromContent(content);
            if (extracted.length > 0) {
                images.push(...extracted);
                return { images, originalResponse: data };
            }
        }

        if (Array.isArray(content)) {
            const extracted = this.extractImagesFromObject(content);
            if (extracted.length > 0) {
                images.push(...extracted);
                return { images, originalResponse: data };
            }
        }

        if (message && typeof message === 'object') {
            const extracted = this.extractImagesFromObject(message);
            if (extracted.length > 0) {
                images.push(...extracted);
                return { images, originalResponse: data };
            }
        }

        const recursiveExtracted = this.extractImagesFromObject(data);
        if (recursiveExtracted.length > 0) {
            images.push(...recursiveExtracted);
            return { images, originalResponse: data };
        }

        return { images, originalResponse: data };
    }

    private static extractImagesFromContent(content: string): string[] {
        const images: string[] = [];
        const seen = new Set<string>();
        const add = (raw: unknown) => this.addImageCandidate(raw, images, seen);

        const markdownImageRegex = /!\[[^\]]*\]\(([^)]+)\)/g;
        let match;
        while ((match = markdownImageRegex.exec(content)) !== null) {
            add(match[1]);
        }

        const markdownLinkRegex = /\[[^\]]*\]\(([^)]+)\)/g;
        while ((match = markdownLinkRegex.exec(content)) !== null) {
            add(match[1]);
        }

        const dataUrlRegex = /data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=\s]+/g;
        while ((match = dataUrlRegex.exec(content)) !== null) {
            add(match[0]);
        }

        const genericUrlRegex = /https?:\/\/[^\s<>"'`]+/gi;
        while ((match = genericUrlRegex.exec(content)) !== null) {
            add(match[0]);
        }

        try {
            const parsed = JSON.parse(content);
            this.extractImagesFromObject(parsed).forEach(add);
        } catch (e) {
            // Plain text response.
        }

        return images;
    }

    private static extractImagesFromObject(value: any): string[] {
        const images: string[] = [];
        const seen = new Set<string>();
        const add = (raw: unknown) => this.addImageCandidate(raw, images, seen);

        const visit = (current: any) => {
            if (!current) return;

            if (typeof current === 'string') {
                add(current);
                this.extractImagesFromContent(current).forEach(add);
                return;
            }

            if (Array.isArray(current)) {
                current.forEach(visit);
                return;
            }

            if (typeof current !== 'object') return;

            if (current.b64_json) add(current.b64_json);
            if (current.base64) add(current.base64);
            if (current.image_base64) add(current.image_base64);
            if (current.inline_data?.data) add(current.inline_data.data);
            if (current.inlineData?.data) add(current.inlineData.data);
            if (current.url) add(current.url);
            if (current.uri) add(current.uri);
            if (current.file) add(current.file);
            if (current.file_url) add(current.file_url);
            if (current.fileUrl) add(current.fileUrl);
            if (current.file_uri) add(current.file_uri);
            if (current.fileUri) add(current.fileUri);
            if (current.image) add(current.image);
            if (current.imageUrl) add(current.imageUrl);
            if (current.imageURL) add(current.imageURL);
            if (current.image_url?.url) add(current.image_url.url);
            if (current.output) add(current.output);
            if (current.result) add(current.result);
            if (current.content) add(current.content);

            Object.values(current).forEach(visit);
        };

        visit(value);
        return images;
    }

    private static addImageCandidate(raw: unknown, images: string[], seen: Set<string>) {
        if (typeof raw !== 'string') return;
        const value = this.cleanImageCandidate(raw);
        if (!value || seen.has(value)) return;

        if (value.startsWith('data:image')) {
            images.push(value);
            seen.add(value);
            return;
        }

        if (/^https?:\/\//i.test(value)) {
            images.push(value);
            seen.add(value);
            return;
        }

        if (/^[A-Za-z0-9+/=\s]+$/.test(value) && value.length > 200) {
            const dataUrl = `data:image/png;base64,${value.replace(/\s/g, '')}`;
            if (!seen.has(dataUrl)) {
                images.push(dataUrl);
                seen.add(dataUrl);
            }
        }
    }

    private static cleanImageCandidate(raw: string): string {
        let value = raw.trim();
        value = value.replace(/^["'`([{<]+/, '');

        while (/[\uFF0C\u3002\u3001\u201C\u201D\u2018\u2019"'`.,;:!?]+$/.test(value)) {
            value = value.slice(0, -1).trim();
        }

        const pairs: Array<[string, string]> = [
            [')', '('],
            [']', '['],
            ['}', '{'],
            ['>', '<']
        ];
        let changed = true;
        while (changed) {
            changed = false;
            for (const [close, open] of pairs) {
                if (value.endsWith(close) && this.countChar(value, close) > this.countChar(value, open)) {
                    value = value.slice(0, -1).trim();
                    changed = true;
                }
            }
        }

        return value;
    }

    private static countChar(value: string, char: string): number {
        return value.split(char).length - 1;
    }
}
