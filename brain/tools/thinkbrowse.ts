/**
 * ThinkBrowse Client for Brains
 *
 * Enables brains to perform web research via ThinkBrowse browser automation.
 * Brain sends URL + instructions → ThinkBrowse navigates → Returns data/analysis.
 */

export interface BrowseSession {
  id: string;
  status: 'active' | 'completed' | 'failed';
  createdAt: string;
}

export interface NavigationResult {
  url: string;
  title: string;
  status: number;
}

export interface ExtractionResult {
  data: any;
  selector: string;
  count: number;
}

export interface ScreenshotResult {
  url: string;
  base64?: string;
}

export interface AnalysisResult {
  summary: string;
  insights: string[];
  data?: any;
}

export class ThinkBrowseClient {
  private apiUrl: string;
  private appId: string;
  private apiKey?: string;
  private internalServiceKey?: string;
  private userId: string;

  constructor(config?: { apiUrl?: string; appId?: string; apiKey?: string; internalServiceKey?: string; userId?: string }) {
    this.apiUrl = config?.apiUrl || process.env.THINKBROWSE_API_URL || 'https://mech-browser-service.fly.dev';
    this.appId = config?.appId || process.env.MECH_APP_ID || 'brain-browse';
    this.apiKey = config?.apiKey || process.env.THINKBROWSE_API_KEY || process.env.MECH_API_KEY;
    this.internalServiceKey = config?.internalServiceKey || process.env.THINKBROWSE_INTERNAL_KEY;
    this.userId = config?.userId || process.env.AGENT_ID || 'agentdispatch-brain';
  }

  private getAuthHeaders(): Record<string, string> {
    // Prefer internal service key for service-to-service auth
    if (this.internalServiceKey) {
      return {
        'X-Internal-Service-Key': this.internalServiceKey,
        'X-User-Id': this.userId,
      };
    }
    // Fall back to API key auth
    return {
      'X-App-ID': this.appId,
      ...(this.apiKey && { 'X-API-Key': this.apiKey })
    };
  }

  /**
   * Create a new browsing session
   */
  async createSession(options?: {
    browser?: 'chromium' | 'firefox' | 'webkit';
    stealth?: boolean;
  }): Promise<BrowseSession> {
    console.log('[ThinkBrowse] Creating session...');

    const response = await fetch(`${this.apiUrl}/api/sessions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...this.getAuthHeaders()
      },
      body: JSON.stringify({
        browser: options?.browser || 'chromium',
        stealth: options?.stealth ?? true,
        metadata: {
          initiator: 'brain',
          timestamp: new Date().toISOString()
        }
      })
    });

    if (!response.ok) {
      throw new Error(`Failed to create session: ${await response.text()}`);
    }

    const result = await response.json();
    // API returns {success: true, data: {sessionId: "..."}}
    const sessionId = result.data?.sessionId || result.sessionId || result.id;
    console.log(`[ThinkBrowse] Session created: ${sessionId}`);

    return {
      id: sessionId,
      status: 'active',
      createdAt: new Date().toISOString()
    };
  }

  /**
   * Navigate to a URL
   */
  async navigate(sessionId: string, url: string, options?: {
    waitFor?: string;
    timeout?: number;
  }): Promise<NavigationResult> {
    console.log(`[ThinkBrowse] Navigating to: ${url}`);

    const response = await fetch(`${this.apiUrl}/api/sessions/${sessionId}/navigate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...this.getAuthHeaders()
      },
      body: JSON.stringify({
        url,
        wait_for: options?.waitFor,
        timeout: options?.timeout || 30000
      })
    });

    if (!response.ok) {
      throw new Error(`Navigation failed: ${await response.text()}`);
    }

    const result = await response.json();

    return {
      url: result.url,
      title: result.title,
      status: result.status
    };
  }

  /**
   * Extract data from page using CSS selector
   */
  async extract(sessionId: string, selector: string, options?: {
    attribute?: string;
    multiple?: boolean;
  }): Promise<ExtractionResult> {
    console.log(`[ThinkBrowse] Extracting: ${selector}`);

    const response = await fetch(`${this.apiUrl}/api/sessions/${sessionId}/extract`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...this.getAuthHeaders()
      },
      body: JSON.stringify({
        selector,
        attribute: options?.attribute,
        multiple: options?.multiple ?? true
      })
    });

    if (!response.ok) {
      throw new Error(`Extraction failed: ${await response.text()}`);
    }

    const result = await response.json();

    return {
      data: result.data,
      selector,
      count: Array.isArray(result.data) ? result.data.length : 1
    };
  }

  /**
   * Get page text content
   */
  async getTextContent(sessionId: string, selector?: string): Promise<string> {
    const response = await fetch(`${this.apiUrl}/api/sessions/${sessionId}/text`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...this.getAuthHeaders()
      },
      body: JSON.stringify({
        selector: selector || 'body'
      })
    });

    if (!response.ok) {
      throw new Error(`Text extraction failed: ${await response.text()}`);
    }

    const result = await response.json();
    return result.text;
  }

  /**
   * Take screenshot
   */
  async screenshot(sessionId: string, options?: {
    fullPage?: boolean;
    selector?: string;
  }): Promise<ScreenshotResult> {
    console.log('[ThinkBrowse] Taking screenshot...');

    const response = await fetch(`${this.apiUrl}/api/sessions/${sessionId}/screenshot`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...this.getAuthHeaders()
      },
      body: JSON.stringify({
        full_page: options?.fullPage ?? false,
        selector: options?.selector
      })
    });

    if (!response.ok) {
      throw new Error(`Screenshot failed: ${await response.text()}`);
    }

    const result = await response.json();

    return {
      url: result.url,
      base64: result.base64
    };
  }

  /**
   * Analyze page content with AI
   */
  async analyze(sessionId: string, prompt: string): Promise<AnalysisResult> {
    console.log(`[ThinkBrowse] Analyzing: ${prompt.substring(0, 50)}...`);

    const response = await fetch(`${this.apiUrl}/api/sessions/${sessionId}/analyze`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...this.getAuthHeaders()
      },
      body: JSON.stringify({
        prompt,
        include_screenshot: true
      })
    });

    if (!response.ok) {
      throw new Error(`Analysis failed: ${await response.text()}`);
    }

    const result = await response.json();

    return {
      summary: result.summary,
      insights: result.insights || [],
      data: result.data
    };
  }

  /**
   * Close session
   */
  async closeSession(sessionId: string): Promise<void> {
    await fetch(`${this.apiUrl}/api/sessions/${sessionId}`, {
      method: 'DELETE',
      headers: {
        ...this.getAuthHeaders()
      }
    });

    console.log(`[ThinkBrowse] Session ${sessionId} closed`);
  }

  /**
   * High-level: Research a topic
   *
   * Creates session → Navigates → Extracts → Analyzes → Closes
   */
  async research(params: {
    url: string;
    prompt: string;
    extractSelector?: string;
  }): Promise<{
    url: string;
    title: string;
    content: string;
    analysis: AnalysisResult;
    screenshot?: string;
  }> {
    const session = await this.createSession({ stealth: true });

    try {
      // Navigate
      const nav = await this.navigate(session.id, params.url);

      // Get content
      const content = await this.getTextContent(session.id, params.extractSelector);

      // Analyze
      const analysis = await this.analyze(session.id, params.prompt);

      // Optional screenshot
      const screenshot = await this.screenshot(session.id);

      return {
        url: nav.url,
        title: nav.title,
        content: content.substring(0, 5000),  // Limit content size
        analysis,
        screenshot: screenshot.url
      };

    } finally {
      await this.closeSession(session.id);
    }
  }

  /**
   * High-level: Monitor a URL for changes
   */
  async checkUrl(url: string): Promise<{
    accessible: boolean;
    status: number;
    title: string;
    error?: string;
  }> {
    const session = await this.createSession();

    try {
      const nav = await this.navigate(session.id, url, { timeout: 10000 });

      return {
        accessible: true,
        status: nav.status,
        title: nav.title
      };

    } catch (error) {
      return {
        accessible: false,
        status: 0,
        title: '',
        error: String(error)
      };

    } finally {
      await this.closeSession(session.id);
    }
  }
}

/**
 * Create ThinkBrowse client from environment
 */
export function createThinkBrowseClient(): ThinkBrowseClient {
  return new ThinkBrowseClient();
}
