import { Orderbook, SupportedProvider } from '@0x/asset-swapper';
import * as express from 'express';
import { Connection } from 'typeorm';

import { SRA_PATH } from './constants';
import { getDBConnectionAsync } from './db_connection';
import { logger } from './logger';
import { OrderBookServiceOrderProvider } from './order_book_service_order_provider';
import { runHttpServiceAsync } from './runners/http_service_runner';
import { runOrderWatcherServiceAsync } from './runners/order_watcher_service_runner';
import { OrderBookService } from './services/orderbook_service';
import { StakingDataService } from './services/staking_data_service';
import { SwapService } from './services/swap_service';
import { WebsocketSRAOpts } from './types';
import { MeshClient } from './utils/mesh_client';
import { OrderStoreDbAdapter } from './utils/order_store_db_adapter';

export interface AppDependencies {
    connection: Connection;
    stakingDataService: StakingDataService;
    meshClient?: MeshClient;
    orderBookService: OrderBookService;
    swapService?: SwapService;
    provider: SupportedProvider;
    websocketOpts: Partial<WebsocketSRAOpts>;
}

/**
 * Instantiates dependencies required to run the app. Uses default settings based on config
 * @param config should contain a URI for mesh to listen to, and the ethereum RPC URL
 */
export async function getDefaultAppDependenciesAsync(
    provider: SupportedProvider,
    config: {
        // hack (xianny): the Mesh client constructor has a fire-and-forget promise so we are unable
        // to catch initialisation errors. Allow the calling function to skip Mesh initialization by
        // not providing a websocket URI
        MESH_WEBSOCKET_URI?: string;
        MESH_HTTP_URI?: string;
    },
): Promise<AppDependencies> {
    const connection = await getDBConnectionAsync();
    const stakingDataService = new StakingDataService(connection);

    let meshClient: MeshClient | undefined;
    if (config.MESH_WEBSOCKET_URI !== undefined) {
        meshClient = new MeshClient(config.MESH_WEBSOCKET_URI, config.MESH_HTTP_URI);
    } else {
        logger.warn(`Skipping Mesh client creation because no URI provided`);
    }

    const orderBookService = new OrderBookService(connection, meshClient);

    let swapService: SwapService | undefined;
    try {
        swapService = createSwapServiceFromOrderBookService(orderBookService, provider);
    } catch (err) {
        logger.error(err);
    }

    const websocketOpts = { path: SRA_PATH };

    return {
        connection,
        stakingDataService,
        meshClient,
        orderBookService,
        swapService,
        provider,
        websocketOpts,
    };
}
/**
 * starts the app with dependencies injected
 * @param dependencies  all values are optional and will be filled with reasonable defaults, with one
 *                      exception. if a `meshClient` is not provided, the API will start without a
 *                      connection to mesh.
 * @return the app object
 */
export async function getAppAsync(
    dependencies: AppDependencies,
    config: {
        HTTP_PORT: string;
        ETHEREUM_RPC_URL: string;
        HTTP_KEEP_ALIVE_TIMEOUT: number;
        HTTP_HEADERS_TIMEOUT: number;
    },
): Promise<Express.Application> {
    const app = express();
    await runHttpServiceAsync(dependencies, config, app);
    if (dependencies.meshClient !== undefined) {
        try {
            await runOrderWatcherServiceAsync(dependencies.connection, dependencies.meshClient);
        } catch (e) {
            logger.error(`Error attempting to start Order Watcher service, [${e}]`);
        }
    } else {
        logger.warn('No mesh client provided, API running without Order Watcher');
    }
    return app;
}

function createSwapServiceFromOrderBookService(
    orderBookService: OrderBookService,
    provider: SupportedProvider,
): SwapService {
    const orderStore = new OrderStoreDbAdapter(orderBookService);
    const orderProvider = new OrderBookServiceOrderProvider(orderStore, orderBookService);
    const orderBook = new Orderbook(orderProvider, orderStore);
    return new SwapService(orderBook, provider);
}
