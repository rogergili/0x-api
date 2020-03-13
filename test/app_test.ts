import {
    ISwapQuoter,
    LiquidityForTakerMakerAssetDataPair,
    MarketBuySwapQuote,
    MarketOperation,
    MarketSellSwapQuote,
    SwapQuoteBase,
    SwapQuoteInfo,
    // SwapQuoteRequestOpts,
} from '@0x/asset-swapper';
import { ContractAddresses, getContractAddressesForChainOrThrow } from '@0x/contract-addresses';
import { WETH9Contract, ERC20TokenContract } from '@0x/contract-wrappers';
import { BlockchainLifecycle, web3Factory } from '@0x/dev-utils';
import { runMigrationsOnceAsync } from '@0x/migrations';
import { Web3ProviderEngine } from '@0x/subproviders';
import { BigNumber } from '@0x/utils';
import { Web3Wrapper } from '@0x/web3-wrapper';
import * as HttpStatus from 'http-status-codes';
import 'mocha';
import * as request from 'supertest';

import { getAppAsync, getDefaultAppDependenciesAsync } from '../src/app';
import * as config from '../src/config';
import { DEFAULT_PAGE, DEFAULT_PER_PAGE, SRA_PATH, SWAP_PATH } from '../src/constants';

import { expect } from './utils/expect';

let app: Express.Application;

let web3Wrapper: Web3Wrapper;
let provider: Web3ProviderEngine;
let accounts: string[];
let blockchainLifecycle: BlockchainLifecycle;

class SwapQuoterStub implements ISwapQuoter {
    public quoteInfo: SwapQuoteInfo = {
        feeTakerAssetAmount: new BigNumber(0),
        takerAssetAmount: new BigNumber(0),
        totalTakerAssetAmount: new BigNumber(0),
        makerAssetAmount: new BigNumber(0),
        protocolFeeInWeiAmount: new BigNumber(0),
        gas: 0,
    };

    public baseSwapQuote: SwapQuoteBase = {
        takerAssetData: '0x00',
        makerAssetData: '0x00',
        gasPrice: new BigNumber(0),
        orders: [],
        bestCaseQuoteInfo: this.quoteInfo,
        worstCaseQuoteInfo: this.quoteInfo,
        sourceBreakdown: {},
    };

    public marketBuySwapQuote: MarketBuySwapQuote = {
        ...this.baseSwapQuote,
        makerAssetFillAmount: new BigNumber(0),
        type: MarketOperation.Buy,
    };

    public marketSellSwapQuote: MarketSellSwapQuote = {
        ...this.baseSwapQuote,
        takerAssetFillAmount: new BigNumber(0),
        type: MarketOperation.Sell,
    };

    public batchMarketBuySwapQuote: MarketBuySwapQuote[] = [this.marketBuySwapQuote];

    // tslint:disable-next-line:prefer-function-over-method
    public async getMarketBuySwapQuoteAsync(
        /* parameters commented out because tsc complains they're not used
        makerTokenAddress: string,
        takerTokenAddress: string,
        makerAssetBuyAmount: BigNumber,
        options: Partial<SwapQuoteRequestOpts> = {},
        */
    ): Promise<MarketBuySwapQuote> {
        return this.marketBuySwapQuote;
    }

    // tslint:disable-next-line:prefer-function-over-method
    public async getMarketSellSwapQuoteAsync(
        /* parameters commented out because tsc complains they're not used
        makerTokenAddress: string,
        takerTokenAddress: string,
        takerAssetSellAmount: BigNumber,
        options: Partial<SwapQuoteRequestOpts> = {},
        */
    ): Promise<MarketSellSwapQuote> {
        return this.marketSellSwapQuote;
    }

    // tslint:disable-next-line:prefer-function-over-method
    public async getBatchMarketBuySwapQuoteForAssetDataAsync(
        /* parameters commented out because tsc complains they're not used
        makerAssetDatas: string[],
        takerAssetData: string,
        makerAssetBuyAmount: BigNumber[],
        options: Partial<SwapQuoteRequestOpts> = {},
        */
    ): Promise<Array<MarketBuySwapQuote | undefined>> {
        return [this.marketBuySwapQuote];
    }

    // tslint:disable-next-line:prefer-function-over-method
    public async getLiquidityForMakerTakerAssetDataPairAsync(
        /* parameters commented out because tsc complains they're not used
        makerAssetData: string,
        takerAssetData: string,
        */
    ): Promise<LiquidityForTakerMakerAssetDataPair> {
        return Promise.reject('unimplemented');
    }

    // tslint:disable-next-line:prefer-function-over-method
    public async getMarketSellSwapQuoteForAssetDataAsync(
        /* parameters commented out because tsc complains they're not used
        makerAssetData: string,
        takerAssetData: string,
        takerAssetSellAmount: BigNumber,
        options?: Partial<SwapQuoteRequestOpts>,
        */
    ): Promise<MarketSellSwapQuote> {
        return this.marketSellSwapQuote;
    }

}

new SwapQuoterStub(); // just to compile; sandboxing. fuck you tsc.

describe('app test', () => {
    before(async () => {
        // start ganache and run contract migrations
        const ganacheConfigs = {
            shouldUseInProcessGanache: false,
            shouldAllowUnlimitedContractSize: true,
            rpcUrl: config.ETHEREUM_RPC_URL,
        };
        provider = web3Factory.getRpcProvider(ganacheConfigs);
        web3Wrapper = new Web3Wrapper(provider);
        blockchainLifecycle = new BlockchainLifecycle(web3Wrapper);
        await blockchainLifecycle.startAsync();
        accounts = await web3Wrapper.getAvailableAddressesAsync();
        const owner = accounts[0];
        await runMigrationsOnceAsync(provider, { from: owner });

        const dependencies = await getDefaultAppDependenciesAsync(provider, config/*, new SwapQuoterStub()*/);

        // start the 0x-api app
        app = await getAppAsync({ ...dependencies }, config);
    });
    it('should not be undefined', () => {
        expect(app).to.not.be.undefined();
    });
    it('should respond to GET /sra/orders', async () => {
        await request(app)
            .get(`${SRA_PATH}/orders`)
            .expect('Content-Type', /json/)
            .expect(HttpStatus.OK)
            .then(response => {
                expect(response.body.perPage).to.equal(DEFAULT_PER_PAGE);
                expect(response.body.page).to.equal(DEFAULT_PAGE);
                expect(response.body.total).to.equal(0);
                expect(response.body.records).to.deep.equal([]);
            });
    });
    describe('should respond to GET /swap/quote', () => {
        it("with INSUFFICIENT_ASSET_LIQUIDITY when there's no liquidity (empty orderbook, sampling excluded, no RFQ)", async () => {
            await request(app)
                .get(`${SWAP_PATH}/quote?buyToken=DAI&sellToken=WETH&buyAmount=100000000000000000&excludedSources=Uniswap,Eth2Dai,Kyber,LiquidityProvider`)
                .expect(HttpStatus.BAD_REQUEST)
                .expect('Content-Type', /json/)
                .then(response => {
                    const responseJson = JSON.parse(response.text);
                    expect(responseJson.reason).to.equal('Validation Failed');
                    expect(responseJson.validationErrors.length).to.equal(1);
                    expect(responseJson.validationErrors[0].field).to.equal('buyAmount');
                    expect(responseJson.validationErrors[0].reason).to.equal('INSUFFICIENT_ASSET_LIQUIDITY');
                });
        });
    });
    describe('should hit RFQ-T when apropriate', () => {
        it('should get a quote from an RFQ-T provider', async () => {
            // set balances and allowances
            const [ makerAddress, takerAddress ] = accounts;
            const buyAmount = new BigNumber(100000000000000000);

            const contractAddresses: ContractAddresses = getContractAddressesForChainOrThrow(
                parseInt(process.env.CHAIN_ID || '1337', 10),
            );

            const wethContract = new WETH9Contract(contractAddresses.etherToken, provider);
            await wethContract.deposit().sendTransactionAsync({ value: buyAmount, from: takerAddress });
            await wethContract.approve(contractAddresses.erc20Proxy, buyAmount).sendTransactionAsync(
                { from: takerAddress },
            );

            const zrxToken = new ERC20TokenContract(contractAddresses.zrxToken, provider);
            await zrxToken.approve(contractAddresses.erc20Proxy, buyAmount).sendTransactionAsync(
                // using buyAmount based on assumption that the RFQ-T provider will be using a "one-to-one" strategy.
                { from: makerAddress },
            );

            await request(app)
                .get(`${SWAP_PATH}/quote?buyToken=ZRX&sellToken=WETH&buyAmount=${buyAmount.toString()}&takerAddress=${takerAddress}&intentOnFilling=true&excludedSources=Uniswap,Eth2Dai,Kyber,LiquidityProvider`)
                .set('0x-api-key', 'koolApiKey1')
                .expect(HttpStatus.OK)
                .expect('Content-Type', /json/);
        });
    });
});
