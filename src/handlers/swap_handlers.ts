import { ERC20BridgeSource, SwapQuoterError } from '@0x/asset-swapper';
import { BigNumber, NULL_ADDRESS } from '@0x/utils';
import * as express from 'express';
import * as HttpStatus from 'http-status-codes';

import { CHAIN_ID } from '../config';
import { DEFAULT_QUOTE_SLIPPAGE_PERCENTAGE, SWAP_DOCS_URL } from '../constants';
import { InternalServerError, RevertAPIError, ValidationError, ValidationErrorCodes } from '../errors';
import { logger } from '../logger';
import { isAPIError, isRevertError } from '../middleware/error_handling';
import { schemas } from '../schemas/schemas';
import { SwapService } from '../services/swap_service';
import { TokenMetadatasForChains } from '../token_metadatas_for_networks';
import { CalculateSwapQuoteParams, ChainId, GetSwapQuoteRequestParams, GetSwapQuoteResponse } from '../types';
import { schemaUtils } from '../utils/schema_utils';
import {
    findTokenAddress,
    getTokenMetadataIfExists,
    isETHSymbol,
    isWETHSymbolOrAddress,
} from '../utils/token_metadata_utils';

export class SwapHandlers {
    private readonly _swapService: SwapService;
    public static rootAsync(_req: express.Request, res: express.Response): void {
        const message = `This is the root of the Swap API. Visit ${SWAP_DOCS_URL} for details about this API.`;
        res.status(HttpStatus.OK).send({ message });
    }
    constructor(swapService: SwapService) {
        this._swapService = swapService;
    }
    public async getSwapQuoteAsync(req: express.Request, res: express.Response): Promise<void> {
        // parse query params
        const {
            sellToken,
            buyToken,
            sellAmount,
            buyAmount,
            takerAddress,
            slippagePercentage,
            gasPrice,
            excludedSources,
            affiliateAddress,
        } = parseGetSwapQuoteRequestParams(req);

        const isETHSell = isETHSymbol(sellToken);
        const sellTokenAddress = findTokenAddressOrThrowApiError(sellToken, 'sellToken', CHAIN_ID);
        const buyTokenAddress = findTokenAddressOrThrowApiError(buyToken, 'buyToken', CHAIN_ID);
        const isWrap = isETHSell && isWETHSymbolOrAddress(buyToken, CHAIN_ID);
        const isUnwrap = isWETHSymbolOrAddress(sellToken, CHAIN_ID) && isETHSymbol(buyToken);
        // if token addresses are the same but a unwrap or wrap operation is requested, ignore error
        if (!isUnwrap && !isWrap && sellTokenAddress === buyTokenAddress) {
            throw new ValidationError(
                ['buyToken', 'sellToken'].map(field => {
                    return {
                        field,
                        code: ValidationErrorCodes.RequiredField,
                        reason: 'buyToken and sellToken must be different',
                    };
                }),
            );
        }

        // if sellToken is not WETH and buyToken is ETH, throw
        if (!isWETHSymbolOrAddress(sellToken, CHAIN_ID) && isETHSymbol(buyToken)) {
            throw new ValidationError([
                {
                    field: 'buyToken',
                    code: ValidationErrorCodes.TokenNotSupported,
                    reason: "Buying ETH is unsupported (set to 'WETH' to received wrapped Ether)",
                },
            ]);
        }

        const calculateSwapQuoteParams: CalculateSwapQuoteParams = {
            buyTokenAddress,
            sellTokenAddress,
            buyAmount,
            sellAmount,
            from: takerAddress,
            isETHSell,
            slippagePercentage,
            gasPrice,
            excludedSources,
            affiliateAddress,
        };

        try {
            let swapQuote: GetSwapQuoteResponse;
            if (isUnwrap) {
                swapQuote = await this._swapService.getSwapQuoteForUnwrapAsync(calculateSwapQuoteParams);
            } else if (isWrap) {
                swapQuote = await this._swapService.getSwapQuoteForWrapAsync(calculateSwapQuoteParams);
            } else {
                swapQuote = await this._swapService.calculateSwapQuoteAsync(calculateSwapQuoteParams);
            }
            res.status(HttpStatus.OK).send(swapQuote);
        } catch (e) {
            // If this is already a transformed error then just re-throw
            if (isAPIError(e)) {
                throw e;
            }
            // Wrap a Revert error as an API revert error
            if (isRevertError(e)) {
                throw new RevertAPIError(e);
            }
            const errorMessage: string = e.message;
            // TODO AssetSwapper can throw raw Errors or InsufficientAssetLiquidityError
            if (
                errorMessage.startsWith(SwapQuoterError.InsufficientAssetLiquidity) ||
                errorMessage.startsWith('NO_OPTIMAL_PATH')
            ) {
                throw new ValidationError([
                    {
                        field: buyAmount ? 'buyAmount' : 'sellAmount',
                        code: ValidationErrorCodes.ValueOutOfRange,
                        reason: SwapQuoterError.InsufficientAssetLiquidity,
                    },
                ]);
            }
            if (errorMessage.startsWith(SwapQuoterError.AssetUnavailable)) {
                throw new ValidationError([
                    {
                        field: 'token',
                        code: ValidationErrorCodes.ValueOutOfRange,
                        reason: e.message,
                    },
                ]);
            }
            logger.info('Uncaught error', e);
            throw new InternalServerError(e.message);
        }
    }
    // tslint:disable-next-line:prefer-function-over-method
    public async getSwapTokensAsync(_req: express.Request, res: express.Response): Promise<void> {
        const tokens = TokenMetadatasForChains.map(tm => ({
            symbol: tm.symbol,
            address: tm.tokenAddresses[CHAIN_ID],
            name: tm.name,
            decimals: tm.decimals,
        }));
        const filteredTokens = tokens.filter(t => t.address !== NULL_ADDRESS);
        res.status(HttpStatus.OK).send({ records: filteredTokens });
    }
    // tslint:disable-next-line:prefer-function-over-method
    public async getTokenPricesAsync(req: express.Request, res: express.Response): Promise<void> {
        const symbolOrAddress = req.query.sellToken || 'WETH';
        const baseAsset = getTokenMetadataIfExists(symbolOrAddress, CHAIN_ID);
        if (!baseAsset) {
            throw new ValidationError([
                {
                    field: 'sellToken',
                    code: ValidationErrorCodes.ValueOutOfRange,
                    reason: `Could not find token ${symbolOrAddress}`,
                },
            ]);
        }
        const unitAmount = new BigNumber(1);
        const records = await this._swapService.getTokenPricesAsync(baseAsset, unitAmount);
        res.status(HttpStatus.OK).send({ records });
    }
}

const findTokenAddressOrThrowApiError = (address: string, field: string, chainId: ChainId): string => {
    try {
        return findTokenAddress(address, chainId);
    } catch (e) {
        throw new ValidationError([
            {
                field,
                code: ValidationErrorCodes.ValueOutOfRange,
                reason: e.message,
            },
        ]);
    }
};

const parseStringArrForERC20BridgeSources = (excludedSources: string[]): ERC20BridgeSource[] => {
    // Need to compare value of the enum instead of the key, as values are used by asset-swapper
    // CurveUsdcDaiUsdt = 'Curve_USDC_DAI_USDT' is excludedSources=Curve_USDC_DAI_USDT
    return excludedSources
        .map(source => (source === '0x' ? 'Native' : source))
        .filter((source: string) =>
            Object.keys(ERC20BridgeSource).find((k: any) => ERC20BridgeSource[k] === source),
        ) as ERC20BridgeSource[];
};

const parseGetSwapQuoteRequestParams = (req: express.Request): GetSwapQuoteRequestParams => {
    // HACK typescript typing does not allow this valid json-schema
    schemaUtils.validateSchema(req.query, schemas.swapQuoteRequestSchema as any);
    const takerAddress = req.query.takerAddress;
    const sellToken = req.query.sellToken;
    const buyToken = req.query.buyToken;
    const sellAmount = req.query.sellAmount === undefined ? undefined : new BigNumber(req.query.sellAmount);
    const buyAmount = req.query.buyAmount === undefined ? undefined : new BigNumber(req.query.buyAmount);
    const gasPrice = req.query.gasPrice === undefined ? undefined : new BigNumber(req.query.gasPrice);
    const slippagePercentage = Number.parseFloat(req.query.slippagePercentage || DEFAULT_QUOTE_SLIPPAGE_PERCENTAGE);
    const excludedSources =
        req.query.excludedSources === undefined
            ? undefined
            : parseStringArrForERC20BridgeSources(req.query.excludedSources.split(','));
    const affiliateAddress = req.query.affiliateAddress;
    return {
        takerAddress,
        sellToken,
        buyToken,
        sellAmount,
        buyAmount,
        slippagePercentage,
        gasPrice,
        excludedSources,
        affiliateAddress,
    };
};
