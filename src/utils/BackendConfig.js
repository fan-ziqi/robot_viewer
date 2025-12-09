/**
 * Backend configuration manager
 * Reads backend port from environment variable (via Vite build-time injection)
 * Falls back to port discovery if env var not available
 */

class BackendConfig {
    constructor() {
        this.backendPort = null;
        this.backendUrl = null;
        this.isInitialized = false;
        this.initPromise = null;
        
        // Get port from build-time environment variable (injected by Vite)
        // This comes from .env file's BACKEND_PORT
        this.envPort = typeof __BACKEND_PORT__ !== 'undefined' ? __BACKEND_PORT__ : null;
        
        // Common ports to try as fallback
        this.commonPorts = [3002, 3001, 3003, 3004, 3005];
    }

    /**
     * Initialize backend configuration
     * First tries env port, then discovers if needed
     */
    async init() {
        if (this.isInitialized) {
            return;
        }

        if (this.initPromise) {
            return this.initPromise;
        }

        this.initPromise = this.initializeBackend();
        await this.initPromise;
        this.isInitialized = true;
    }

    /**
     * Initialize backend configuration
     */
    async initializeBackend() {
        // First, try to use port from .env file (via build-time injection)
        if (this.envPort) {
            const port = parseInt(this.envPort, 10);
            if (!isNaN(port)) {
                // Verify the backend is actually running on this port
                try {
                    const response = await fetch(`http://localhost:${port}/api/config`, {
                        method: 'GET',
                        signal: AbortSignal.timeout(1000) // 1 second timeout
                    });
                    
                    if (response.ok) {
                        const config = await response.json();
                        this.backendPort = config.backendPort || port;
                        this.backendUrl = config.backendUrl || `http://localhost:${port}`;
                        console.log(`✓ Backend configured from .env: ${this.backendUrl}`);
                        return;
                    }
                } catch (error) {
                    console.warn(`⚠ Backend not responding on port ${port} from .env, trying discovery...`);
                }
            }
        }

        // Fallback: try to discover backend by trying common ports
        for (const port of this.commonPorts) {
            try {
                const response = await fetch(`http://localhost:${port}/api/config`, {
                    method: 'GET',
                    signal: AbortSignal.timeout(1000) // 1 second timeout
                });
                
                if (response.ok) {
                    const config = await response.json();
                    this.backendPort = config.backendPort || port;
                    this.backendUrl = config.backendUrl || `http://localhost:${port}`;
                    console.log(`✓ Backend discovered at ${this.backendUrl}`);
                    return;
                }
            } catch (error) {
                // Continue to next port
                continue;
            }
        }

        // If env port was set but not responding, use it anyway (might be starting up)
        if (this.envPort) {
            const port = parseInt(this.envPort, 10);
            if (!isNaN(port)) {
                this.backendPort = port;
                this.backendUrl = `http://localhost:${port}`;
                console.warn(`⚠ Using port ${port} from .env (backend may not be running yet)`);
                return;
            }
        }

        // Last resort: use default
        this.backendPort = 3002;
        this.backendUrl = `http://localhost:3002`;
        console.warn(`⚠ Backend not found, using default port ${this.backendPort}`);
    }

    /**
     * Get backend URL for API calls
     */
    getBackendUrl() {
        if (!this.isInitialized) {
            console.warn('BackendConfig not initialized, using default port 3002');
            return 'http://localhost:3002';
        }
        return this.backendUrl || `http://localhost:${this.backendPort || 3002}`;
    }

    /**
     * Get backend port
     */
    getBackendPort() {
        if (!this.isInitialized) {
            return 3002;
        }
        return this.backendPort || 3002;
    }

    /**
     * Build API URL
     */
    getApiUrl(endpoint) {
        const baseUrl = this.getBackendUrl();
        // Remove leading slash if present
        const cleanEndpoint = endpoint.startsWith('/') ? endpoint.substring(1) : endpoint;
        return `${baseUrl}/${cleanEndpoint}`;
    }
}

// Create singleton instance
const backendConfig = new BackendConfig();

// Initialize on module load
backendConfig.init().catch(err => {
    console.error('Failed to initialize backend config:', err);
});

export default backendConfig;

