import {
    ERC20BridgeSource,
    ExtensionContractType,
    MarketBuySwapQuote,
    MarketSellSwapQuote,
    Orderbook,
    ProtocolFeeUtils,
    SignedOrder,
    SwapQuoteConsumer,
    SwapQuoteOrdersBreakdown,
    SwapQuoter,
    SwapQuoterOpts,
} from '@0x/asset-swapper';
import { getContractAddressesForChainOrThrow } from '@0x/contract-addresses';
import { WETH9Contract } from '@0x/contract-wrappers';
import { assetDataUtils, SupportedProvider } from '@0x/order-utils';
import { AbiEncoder, BigNumber, decodeThrownErrorAsRevertError, RevertError } from '@0x/utils';
import { TxData, Web3Wrapper } from '@0x/web3-wrapper';
import * as _ from 'lodash';

import {
    ASSET_SWAPPER_MARKET_ORDERS_OPTS,
    CHAIN_ID,
    FEE_RECIPIENT_ADDRESS,
    LIQUIDITY_POOL_REGISTRY_ADDRESS,
} from '../config';
import {
    DEFAULT_TOKEN_DECIMALS,
    GAS_LIMIT_BUFFER_PERCENTAGE,
    ONE,
    ONE_SECOND_MS,
    PERCENTAGE_SIG_DIGITS,
    PROTOCOL_FEE_UTILS_POLLING_INTERVAL_IN_MS,
    QUOTE_ORDER_EXPIRATION_BUFFER_MS,
    UNWRAP_QUOTE_GAS,
    WRAP_QUOTE_GAS,
    ZERO,
} from '../constants';
import { logger } from '../logger';
import { TokenMetadatasForChains } from '../token_metadatas_for_networks';
import {
    CalculateSwapQuoteParams,
    GetSwapQuoteResponse,
    GetSwapQuoteResponseLiquiditySource,
    GetTokenPricesResponse,
    TokenMetadata,
} from '../types';
import { orderUtils } from '../utils/order_utils';
import { findTokenDecimalsIfExists } from '../utils/token_metadata_utils';

export class SwapService {
    private readonly _provider: SupportedProvider;
    private readonly _swapQuoter: SwapQuoter;
    private readonly _swapQuoteConsumer: SwapQuoteConsumer;
    private readonly _web3Wrapper: Web3Wrapper;
    private readonly _wethContract: WETH9Contract;
    private readonly _protocolFeeUtils: ProtocolFeeUtils;

    constructor(orderbook: Orderbook, provider: SupportedProvider) {
        this._provider = provider;
        const swapQuoterOpts: Partial<SwapQuoterOpts> = {
            chainId: CHAIN_ID,
            expiryBufferMs: QUOTE_ORDER_EXPIRATION_BUFFER_MS,
            liquidityProviderRegistryAddress: LIQUIDITY_POOL_REGISTRY_ADDRESS,
        };
        this._swapQuoter = new SwapQuoter(this._provider, orderbook, swapQuoterOpts);
        this._swapQuoteConsumer = new SwapQuoteConsumer(this._provider, swapQuoterOpts);
        this._web3Wrapper = new Web3Wrapper(this._provider);

        const contractAddresses = getContractAddressesForChainOrThrow(CHAIN_ID);
        this._wethContract = new WETH9Contract(contractAddresses.etherToken, this._provider);
        this._protocolFeeUtils = new ProtocolFeeUtils(PROTOCOL_FEE_UTILS_POLLING_INTERVAL_IN_MS);
    }

    public async calculateSwapQuoteAsync(params: CalculateSwapQuoteParams): Promise<GetSwapQuoteResponse> {
        let swapQuote;
        const {
            sellAmount,
            buyAmount,
            buyTokenAddress,
            sellTokenAddress,
            slippagePercentage,
            gasPrice: providedGasPrice,
            isETHSell,
            from,
            excludedSources,
            affiliateAddress,
        } = params;
        const assetSwapperOpts = {
            ...ASSET_SWAPPER_MARKET_ORDERS_OPTS,
            slippagePercentage,
            bridgeSlippage: slippagePercentage,
            gasPrice: providedGasPrice,
            excludedSources, // TODO(dave4506): overrides the excluded sources selected by chainId
        };
        if (sellAmount !== undefined) {
            swapQuote = await this._swapQuoter.getMarketSellSwapQuoteAsync(
                buyTokenAddress,
                sellTokenAddress,
                sellAmount,
                assetSwapperOpts,
            );
        } else if (buyAmount !== undefined) {
            swapQuote = await this._swapQuoter.getMarketBuySwapQuoteAsync(
                buyTokenAddress,
                sellTokenAddress,
                buyAmount,
                assetSwapperOpts,
            );
        } else {
            throw new Error('sellAmount or buyAmount required');
        }
        const attributedSwapQuote = this._attributeSwapQuoteOrders(swapQuote);
        const {
            makerAssetAmount,
            totalTakerAssetAmount,
            protocolFeeInWeiAmount: protocolFee,
        } = attributedSwapQuote.bestCaseQuoteInfo;
        const {
            makerAssetAmount: guaranteedMakerAssetAmount,
            totalTakerAssetAmount: guaranteedTotalTakerAssetAmount,
            gas,
        } = attributedSwapQuote.worstCaseQuoteInfo;
        const { orders, gasPrice, sourceBreakdown } = attributedSwapQuote;

        // If ETH was specified as the token to sell then we use the Forwarder
        const extensionContractType = isETHSell ? ExtensionContractType.Forwarder : ExtensionContractType.None;
        const {
            calldataHexString: data,
            ethAmount: value,
            toAddress: to,
        } = await this._swapQuoteConsumer.getCalldataOrThrowAsync(attributedSwapQuote, {
            useExtensionContract: extensionContractType,
        });

        const affiliatedData = this._attributeCallData(data, affiliateAddress);

        let suggestedGasEstimate = new BigNumber(gas);
        if (from) {
            // Force a revert error if the takerAddress does not have enough ETH.
            const txDataValue =
                extensionContractType === ExtensionContractType.Forwarder
                    ? BigNumber.min(value, await this._web3Wrapper.getBalanceInWeiAsync(from))
                    : value;
            const gasEstimate = await this._estimateGasOrThrowRevertErrorAsync({
                to,
                data: affiliatedData,
                from,
                value: txDataValue,
                gasPrice,
            });
            // Take the max of the faux estimate or the real estimate
            suggestedGasEstimate = BigNumber.max(gasEstimate, suggestedGasEstimate);
        }
        // Add a buffer to the gas estimate
        suggestedGasEstimate = suggestedGasEstimate.times(GAS_LIMIT_BUFFER_PERCENTAGE + 1).integerValue();

        const buyTokenDecimals = await this._fetchTokenDecimalsIfRequiredAsync(buyTokenAddress);
        const sellTokenDecimals = await this._fetchTokenDecimalsIfRequiredAsync(sellTokenAddress);
        const unitMakerAssetAmount = Web3Wrapper.toUnitAmount(makerAssetAmount, buyTokenDecimals);
        const unitTakerAssetAMount = Web3Wrapper.toUnitAmount(totalTakerAssetAmount, sellTokenDecimals);
        // Best price
        const price =
            buyAmount === undefined
                ? unitMakerAssetAmount.dividedBy(unitTakerAssetAMount).decimalPlaces(sellTokenDecimals)
                : unitTakerAssetAMount.dividedBy(unitMakerAssetAmount).decimalPlaces(buyTokenDecimals);
        // Guaranteed price before revert occurs
        const guaranteedUnitMakerAssetAmount = Web3Wrapper.toUnitAmount(guaranteedMakerAssetAmount, buyTokenDecimals);
        const guaranteedUnitTakerAssetAMount = Web3Wrapper.toUnitAmount(
            guaranteedTotalTakerAssetAmount,
            sellTokenDecimals,
        );
        const guaranteedPrice =
            buyAmount === undefined
                ? guaranteedUnitMakerAssetAmount
                      .dividedBy(guaranteedUnitTakerAssetAMount)
                      .decimalPlaces(sellTokenDecimals)
                : guaranteedUnitTakerAssetAMount
                      .dividedBy(guaranteedUnitMakerAssetAmount)
                      .decimalPlaces(buyTokenDecimals);

        const apiSwapQuote: GetSwapQuoteResponse = {
            price,
            guaranteedPrice,
            to,
            data: affiliatedData,
            value,
            gas: suggestedGasEstimate,
            from,
            gasPrice,
            protocolFee,
            buyTokenAddress,
            sellTokenAddress,
            buyAmount: makerAssetAmount,
            sellAmount: totalTakerAssetAmount,
            sources: this._convertSourceBreakdownToArray(sourceBreakdown),
            orders: this._cleanSignedOrderFields(orders),
        };
        return apiSwapQuote;
    }

    public async getSwapQuoteForWrapAsync(params: CalculateSwapQuoteParams): Promise<GetSwapQuoteResponse> {
        return this._getSwapQuoteForWethAsync(params, false);
    }

    public async getSwapQuoteForUnwrapAsync(params: CalculateSwapQuoteParams): Promise<GetSwapQuoteResponse> {
        return this._getSwapQuoteForWethAsync(params, true);
    }

    public async getTokenPricesAsync(sellToken: TokenMetadata, unitAmount: BigNumber): Promise<GetTokenPricesResponse> {
        // Gets the price for buying 1 unit (not base unit as this is different between tokens with differing decimals)
        // returns price in sellToken units, e.g What is the price of 1 ZRX (in DAI)
        // Equivalent to performing multiple swap quotes selling sellToken and buying 1 whole buy token
        const takerAssetData = assetDataUtils.encodeERC20AssetData(sellToken.tokenAddress);
        const queryAssetData = TokenMetadatasForChains.filter(m => m.symbol !== sellToken.symbol);
        const chunkSize = 20;
        const assetDataChunks = _.chunk(queryAssetData, chunkSize);
        const allResults = _.flatten(
            await Promise.all(
                assetDataChunks.map(async a => {
                    const encodedAssetData = a.map(m =>
                        assetDataUtils.encodeERC20AssetData(m.tokenAddresses[CHAIN_ID]),
                    );
                    const amounts = a.map(m => Web3Wrapper.toBaseUnitAmount(unitAmount, m.decimals));
                    const quotes = await this._swapQuoter.getBatchMarketBuySwapQuoteForAssetDataAsync(
                        encodedAssetData,
                        takerAssetData,
                        amounts,
                        {
                            ...ASSET_SWAPPER_MARKET_ORDERS_OPTS,
                            bridgeSlippage: 0,
                            maxFallbackSlippage: 0,
                            numSamples: 3,
                        },
                    );
                    return quotes;
                }),
            ),
        );

        const prices = allResults
            .map((quote, i) => {
                if (!quote) {
                    return undefined;
                }
                const buyTokenDecimals = queryAssetData[i].decimals;
                const sellTokenDecimals = sellToken.decimals;
                const { makerAssetAmount, totalTakerAssetAmount } = quote.bestCaseQuoteInfo;
                const unitMakerAssetAmount = Web3Wrapper.toUnitAmount(makerAssetAmount, buyTokenDecimals);
                const unitTakerAssetAmount = Web3Wrapper.toUnitAmount(totalTakerAssetAmount, sellTokenDecimals);
                const price = unitTakerAssetAmount.dividedBy(unitMakerAssetAmount).decimalPlaces(buyTokenDecimals);
                return {
                    symbol: queryAssetData[i].symbol,
                    price,
                };
            })
            .filter(p => p) as GetTokenPricesResponse;
        return prices;
    }
    private async _getSwapQuoteForWethAsync(
        params: CalculateSwapQuoteParams,
        isUnwrap: boolean,
    ): Promise<GetSwapQuoteResponse> {
        const {
            from,
            buyTokenAddress,
            sellTokenAddress,
            buyAmount,
            sellAmount,
            affiliateAddress,
            gasPrice: providedGasPrice,
        } = params;
        const amount = buyAmount || sellAmount;
        if (amount === undefined) {
            throw new Error('sellAmount or buyAmount required');
        }
        const data = (isUnwrap
            ? this._wethContract.withdraw(amount)
            : this._wethContract.deposit()
        ).getABIEncodedTransactionData();
        const value = isUnwrap ? ZERO : amount;
        const affiliatedData = this._attributeCallData(data, affiliateAddress);
        // TODO: consider not using protocol fee utils due to lack of need for an aggresive gas price for wrapping/unwrapping
        const gasPrice = providedGasPrice || (await this._protocolFeeUtils.getGasPriceEstimationOrThrowAsync());
        const gasEstimate = isUnwrap ? UNWRAP_QUOTE_GAS : WRAP_QUOTE_GAS;
        const apiSwapQuote: GetSwapQuoteResponse = {
            price: ONE,
            guaranteedPrice: ONE,
            to: this._wethContract.address,
            data: affiliatedData,
            value,
            gas: gasEstimate,
            from,
            gasPrice,
            protocolFee: ZERO,
            buyTokenAddress,
            sellTokenAddress,
            buyAmount: amount,
            sellAmount: amount,
            sources: [],
            orders: [],
        };
        return apiSwapQuote;
    }
    // tslint:disable-next-line: prefer-function-over-method
    private _convertSourceBreakdownToArray(
        sourceBreakdown: SwapQuoteOrdersBreakdown,
    ): GetSwapQuoteResponseLiquiditySource[] {
        const defaultSourceBreakdown: SwapQuoteOrdersBreakdown = Object.assign(
            {},
            ...Object.values(ERC20BridgeSource).map(s => ({ [s]: ZERO })),
        );

        const breakdown: GetSwapQuoteResponseLiquiditySource[] = [];
        return Object.entries({ ...defaultSourceBreakdown, ...sourceBreakdown }).reduce(
            (acc: GetSwapQuoteResponseLiquiditySource[], [source, percentage]) => {
                return [
                    ...acc,
                    {
                        name: source === ERC20BridgeSource.Native ? '0x' : source,
                        proportion: new BigNumber(percentage.toPrecision(PERCENTAGE_SIG_DIGITS)),
                    },
                ];
            },
            breakdown,
        );
    }

    private async _estimateGasOrThrowRevertErrorAsync(txData: Partial<TxData>): Promise<BigNumber> {
        // Perform this concurrently
        // if the call fails the gas estimation will also fail, we can throw a more helpful
        // error message than gas estimation failure
        const estimateGasPromise = this._web3Wrapper.estimateGasAsync(txData).catch(_e => 0);
        await this._throwIfCallIsRevertErrorAsync(txData);
        const gas = await estimateGasPromise;
        return new BigNumber(gas);
    }

    // tslint:disable-next-line:prefer-function-over-method
    private _attributeSwapQuoteOrders(
        swapQuote: MarketSellSwapQuote | MarketBuySwapQuote,
    ): MarketSellSwapQuote | MarketBuySwapQuote {
        // Where possible, attribute any fills of these orders to the Fee Recipient Address
        const attributedOrders = swapQuote.orders.map(o => {
            try {
                const decodedAssetData = assetDataUtils.decodeAssetDataOrThrow(o.makerAssetData);
                if (orderUtils.isBridgeAssetData(decodedAssetData)) {
                    return {
                        ...o,
                        feeRecipientAddress: FEE_RECIPIENT_ADDRESS,
                    };
                }
                // tslint:disable-next-line:no-empty
            } catch (err) {}
            // Default to unmodified order
            return o;
        });
        const attributedSwapQuote = {
            ...swapQuote,
            orders: attributedOrders,
        };
        return attributedSwapQuote;
    }

    // tslint:disable-next-line:prefer-function-over-method
    private _attributeCallData(data: string, affiliateAddress?: string): string {
        const affiliateAddressOrDefault = affiliateAddress ? affiliateAddress : FEE_RECIPIENT_ADDRESS;
        const affiliateCallDataEncoder = new AbiEncoder.Method({
            constant: true,
            outputs: [],
            name: 'ZeroExAPIAffiliate',
            inputs: [{ name: 'affiliate', type: 'address' }, { name: 'timestamp', type: 'uint256' }],
            payable: false,
            stateMutability: 'view',
            type: 'function',
        });
        const timestamp = new BigNumber(Date.now() / ONE_SECOND_MS).integerValue();
        const encodedAffiliateData = affiliateCallDataEncoder.encode([affiliateAddressOrDefault, timestamp]);
        const affiliatedData = `${data}${encodedAffiliateData.slice(2)}`;
        return affiliatedData;
    }

    // tslint:disable-next-line:prefer-function-over-method
    private _cleanSignedOrderFields(orders: SignedOrder[]): SignedOrder[] {
        return orders.map(o => ({
            chainId: o.chainId,
            exchangeAddress: o.exchangeAddress,
            makerAddress: o.makerAddress,
            takerAddress: o.takerAddress,
            feeRecipientAddress: o.feeRecipientAddress,
            senderAddress: o.senderAddress,
            makerAssetAmount: o.makerAssetAmount,
            takerAssetAmount: o.takerAssetAmount,
            makerFee: o.makerFee,
            takerFee: o.takerFee,
            expirationTimeSeconds: o.expirationTimeSeconds,
            salt: o.salt,
            makerAssetData: o.makerAssetData,
            takerAssetData: o.takerAssetData,
            makerFeeAssetData: o.makerFeeAssetData,
            takerFeeAssetData: o.takerFeeAssetData,
            signature: o.signature,
        }));
    }
    private async _fetchTokenDecimalsIfRequiredAsync(tokenAddress: string): Promise<number> {
        // HACK(dekz): Our ERC20Wrapper does not have decimals as it is optional
        // so we must encode this ourselves
        let decimals = findTokenDecimalsIfExists(tokenAddress, CHAIN_ID);
        if (!decimals) {
            const decimalsEncoder = new AbiEncoder.Method({
                constant: true,
                inputs: [],
                name: 'decimals',
                outputs: [{ name: '', type: 'uint8' }],
                payable: false,
                stateMutability: 'view',
                type: 'function',
            });
            const encodedCallData = decimalsEncoder.encode(tokenAddress);
            try {
                const result = await this._web3Wrapper.callAsync({ data: encodedCallData, to: tokenAddress });
                decimals = decimalsEncoder.strictDecodeReturnValue<BigNumber>(result).toNumber();
                logger.info(`Unmapped token decimals ${tokenAddress} ${decimals}`);
            } catch (err) {
                logger.error(`Error fetching token decimals ${tokenAddress}`);
                decimals = DEFAULT_TOKEN_DECIMALS;
            }
        }
        return decimals;
    }
    private async _throwIfCallIsRevertErrorAsync(txData: Partial<TxData>): Promise<void> {
        let callResult;
        let revertError;
        try {
            callResult = await this._web3Wrapper.callAsync(txData);
        } catch (e) {
            // RPCSubprovider can throw if .error exists on the response payload
            // This `error` response occurs from Parity nodes (incl Alchemy) but not on INFURA (geth)
            revertError = decodeThrownErrorAsRevertError(e);
            throw revertError;
        }
        try {
            revertError = RevertError.decode(callResult, false);
        } catch (e) {
            // No revert error
        }
        if (revertError) {
            throw revertError;
        }
    }
}
