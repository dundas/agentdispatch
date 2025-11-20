#!/usr/bin/env python3
"""
Programmatic Digital Ocean App Platform Deployment (Python)

This script uses the Digital Ocean API to:
- Create apps
- Update environment variables
- Deploy and monitor deployments

Requirements:
    pip install requests pyyaml

Usage:
    export DIGITALOCEAN_TOKEN="dop_v1_..."
    python scripts/deploy-to-digitalocean.py
"""

import os
import sys
import time
import json
import requests
from typing import Dict, List, Optional

DIGITALOCEAN_TOKEN = os.getenv('DIGITALOCEAN_TOKEN')
API_BASE = 'https://api.digitalocean.com/v2'

if not DIGITALOCEAN_TOKEN:
    print('Error: DIGITALOCEAN_TOKEN environment variable not set')
    print('Get a token from: https://cloud.digitalocean.com/account/api/tokens')
    sys.exit(1)

# API Helper
class DigitalOceanAPI:
    def __init__(self, token: str):
        self.token = token
        self.headers = {
            'Authorization': f'Bearer {token}',
            'Content-Type': 'application/json'
        }

    def request(self, method: str, path: str, data: Optional[Dict] = None) -> Dict:
        """Make API request"""
        url = f'{API_BASE}{path}'
        response = requests.request(
            method=method,
            url=url,
            headers=self.headers,
            json=data
        )
        response.raise_for_status()
        return response.json()

    def list_apps(self) -> List[Dict]:
        """List all apps"""
        result = self.request('GET', '/apps')
        return result.get('apps', [])

    def get_app_by_name(self, name: str) -> Optional[Dict]:
        """Find app by name"""
        apps = self.list_apps()
        for app in apps:
            if app['spec']['name'] == name:
                return app
        return None

    def create_app(self, spec: Dict) -> Dict:
        """Create new app"""
        print(f'🚀 Creating app: {spec["name"]}...')
        result = self.request('POST', '/apps', {'spec': spec})
        return result['app']

    def update_app(self, app_id: str, spec: Dict) -> Dict:
        """Update app spec"""
        print(f'🔄 Updating app {app_id}...')
        result = self.request('PUT', f'/apps/{app_id}', {'spec': spec})
        return result['app']

    def create_deployment(self, app_id: str, force_rebuild: bool = False) -> Dict:
        """Create new deployment"""
        print(f'🏗️  Creating deployment for app {app_id}...')
        result = self.request('POST', f'/apps/{app_id}/deployments', {
            'force_build': force_rebuild
        })
        return result['deployment']

    def get_deployment(self, app_id: str, deployment_id: str) -> Dict:
        """Get deployment status"""
        result = self.request('GET', f'/apps/{app_id}/deployments/{deployment_id}')
        return result['deployment']

    def wait_for_deployment(self, app_id: str, deployment_id: str, max_wait_sec: int = 600) -> Dict:
        """Wait for deployment to complete"""
        print('⏳ Waiting for deployment to complete...')
        start_time = time.time()

        while True:
            deployment = self.get_deployment(app_id, deployment_id)
            phase = deployment['phase']
            progress = deployment.get('progress', {})

            steps_complete = progress.get('steps_successful', 0)
            steps_total = progress.get('steps_total', 0)
            print(f'   Status: {phase} ({steps_complete}/{steps_total} steps)')

            if phase == 'ACTIVE':
                print('✅ Deployment successful!')
                return deployment

            if phase in ['ERROR', 'CANCELED']:
                raise Exception(f'Deployment failed with phase: {phase}')

            elapsed = time.time() - start_time
            if elapsed > max_wait_sec:
                raise Exception(f'Deployment timeout after {max_wait_sec} seconds')

            time.sleep(10)  # Poll every 10 seconds

    def update_env_vars(self, app_id: str, new_env_vars: Dict[str, str]) -> Dict:
        """Update environment variables"""
        print('🔧 Updating environment variables...')

        # Get current spec
        result = self.request('GET', f'/apps/{app_id}')
        spec = result['app']['spec']

        # Update env vars in first service
        if spec.get('services'):
            service = spec['services'][0]
            existing_envs = service.get('envs', [])

            # Create map of existing vars
            env_map = {e['key']: e for e in existing_envs}

            # Add/update new vars
            for key, value in new_env_vars.items():
                env_map[key] = {
                    'key': key,
                    'value': str(value),
                    'scope': 'RUN_TIME',
                    'type': 'GENERAL'
                }

            service['envs'] = list(env_map.values())

        return self.update_app(app_id, spec)


def get_app_spec() -> Dict:
    """Define app specification"""
    return {
        'name': 'admp-server',
        'region': 'nyc',
        'services': [
            {
                'name': 'web',
                'github': {
                    'repo': 'dundas/agentdispatch',
                    'branch': 'main',
                    'deploy_on_push': True
                },
                'dockerfile_path': 'Dockerfile',
                'http_port': 8080,
                'health_check': {
                    'http_path': '/health',
                    'initial_delay_seconds': 5,
                    'period_seconds': 30,
                    'timeout_seconds': 3,
                    'success_threshold': 1,
                    'failure_threshold': 3
                },
                'instance_count': 1,
                'instance_size_slug': 'basic-xxs',
                'envs': [
                    {'key': 'NODE_ENV', 'value': 'production', 'scope': 'RUN_TIME'},
                    {'key': 'PORT', 'value': '8080', 'scope': 'RUN_TIME'},
                    {'key': 'CORS_ORIGIN', 'value': '*', 'scope': 'RUN_TIME'},
                    {'key': 'HEARTBEAT_INTERVAL_MS', 'value': '60000', 'scope': 'RUN_TIME'},
                    {'key': 'HEARTBEAT_TIMEOUT_MS', 'value': '300000', 'scope': 'RUN_TIME'},
                    {'key': 'MESSAGE_TTL_SEC', 'value': '86400', 'scope': 'RUN_TIME'},
                    {'key': 'MAX_MESSAGE_SIZE_KB', 'value': '256', 'scope': 'RUN_TIME'},
                    {'key': 'MAX_MESSAGES_PER_AGENT', 'value': '1000', 'scope': 'RUN_TIME'}
                ],
                'routes': [{'path': '/'}]
            }
        ]
    }


def main():
    """Main deployment function"""
    try:
        api = DigitalOceanAPI(DIGITALOCEAN_TOKEN)
        app_spec = get_app_spec()
        app_name = app_spec['name']

        # Check if app exists
        app = api.get_app_by_name(app_name)

        if app:
            print(f'✅ App "{app_name}" already exists (ID: {app["id"]})')
            print(f'   Live URL: {app.get("live_url", "N/A")}')

            # Update app
            print('\n🔄 Updating app configuration...')
            app = api.update_app(app['id'], app_spec)

            # Create new deployment
            deployment = api.create_deployment(app['id'], force_rebuild=True)
            print(f'   Deployment ID: {deployment["id"]}')

            # Wait for deployment
            api.wait_for_deployment(app['id'], deployment['id'])

        else:
            print(f'🆕 Creating new app "{app_name}"...')
            app = api.create_app(app_spec)
            print(f'   App ID: {app["id"]}')
            print(f'   Live URL: {app.get("live_url", "Building...")}')

            # Wait for initial deployment
            if app.get('active_deployment'):
                api.wait_for_deployment(app['id'], app['active_deployment']['id'])

        print('\n🎉 Deployment complete!')
        print(f'   App URL: {app.get("live_url") or app.get("default_ingress")}')
        print(f'   Dashboard: https://cloud.digitalocean.com/apps/{app["id"]}')

        # Example: Update specific env vars
        # api.update_env_vars(app['id'], {
        #     'NEW_FEATURE_FLAG': 'true',
        #     'API_VERSION': 'v2'
        # })

    except requests.HTTPError as e:
        print(f'❌ API Error: {e.response.status_code}')
        print(f'   Response: {e.response.text}')
        sys.exit(1)
    except Exception as e:
        print(f'❌ Deployment failed: {str(e)}')
        sys.exit(1)


if __name__ == '__main__':
    main()
