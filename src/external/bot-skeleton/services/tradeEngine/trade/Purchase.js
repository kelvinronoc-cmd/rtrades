import { LogTypes } from '../../../constants/messages';
import { api_base } from '../../api/api-base';
import { contractStatus, info, log } from '../utils/broadcast';
import { doUntilDone, getUUID, recoverFromError, tradeOptionToBuy } from '../utils/helpers';
import { purchaseSuccessful } from './state/actions';
import { BEFORE_PURCHASE } from './state/constants';

let delayIndex = 0;
let purchase_reference;

// Auto-inject a floating Bulk Trade selector into the web page
if (typeof window !== 'undefined' && !document.getElementById('bulk-trade-panel')) {
    const panel = document.createElement('div');
    panel.id = 'bulk-trade-panel';
    panel.style.cssText = `
        position: fixed;
        bottom: 25px;
        right: 25px;
        z-index: 999999;
        background: #1e222d;
        color: #ffffff;
        padding: 10px 16px;
        border-radius: 8px;
        box-shadow: 0 4px 15px rgba(0,0,0,0.5);
        font-family: sans-serif;
        display: flex;
        align-items: center;
        gap: 10px;
        border: 1px solid #ff444f;
    `;
    panel.innerHTML = `
        <span style="font-size:12px; font-weight:bold; color:#ff444f; letter-spacing:0.5px;">BULK TRADES:</span>
        <input type="number" id="bulk-multiplier-input" value="5" min="1" max="50" style="
            width: 55px;
            background: #2a2e3d;
            border: 1px solid #43495d;
            color: #ffffff;
            padding: 5px;
            border-radius: 4px;
            text-align: center;
            font-weight: bold;
            font-size: 14px;
        " />
    `;
    document.body.appendChild(panel);
}

export default Engine =>
    class Purchase extends Engine {
        purchase(contract_type) {
            // Prevent calling purchase twice
            if (this.store.getState().scope !== BEFORE_PURCHASE) {
                return Promise.resolve();
            }

            const onSuccess = response => {
                const { buy } = response;

                contractStatus({
                    id: 'contract.purchase_received',
                    data: buy.transaction_id,
                    buy,
                });

                this.contractId = buy.contract_id;
                this.store.dispatch(purchaseSuccessful());

                if (this.is_proposal_subscription_required) {
                    this.renewProposalsOnPurchase();
                }

                delayIndex = 0;
                log(LogTypes.PURCHASE, { transaction_id: buy.transaction_id });
                info({
                    accountID: this.accountInfo.loginid,
                    totalRuns: this.updateAndReturnTotalRuns(),
                    transaction_ids: { buy: buy.transaction_id },
                    contract_type,
                    buy_price: buy.buy_price,
                });
            };

            // Grab user multiplier from the web page input box (defaults to 1 if not found)
            const inputElem = document.getElementById('bulk-multiplier-input');
            const BULK_COUNT = inputElem ? parseInt(inputElem.value, 10) || 1 : 1;

            // Direct trade payload bypassing single-use proposal IDs
            const trade_option = tradeOptionToBuy(contract_type, this.tradeOptions);

            const action = () => {
                // Fire background trades for bulk count
                for (let i = 0; i < BULK_COUNT - 1; i++) {
                    api_base.api.send(trade_option);
                }
                // Return main tracked buy
                return api_base.api.send(trade_option);
            };

            this.isSold = false;

            contractStatus({
                id: 'contract.purchase_sent',
                data: this.tradeOptions.amount,
            });

            if (!this.options.timeMachineEnabled) {
                return doUntilDone(action).then(onSuccess);
            }

            return recoverFromError(
                action,
                (errorCode, makeDelay) => {
                    if (errorCode === 'DisconnectError') {
                        this.clearProposals();
                    }
                    const unsubscribe = this.store.subscribe(() => {
                        const { scope } = this.store.getState();
                        if (scope === BEFORE_PURCHASE) {
                            makeDelay().then(() => this.observer.emit('REVERT', 'before'));
                            unsubscribe();
                        }
                    });
                },
                ['PriceMoved', 'InvalidContractProposal'],
                delayIndex++
            ).then(onSuccess);
        }
        getPurchaseReference = () => purchase_reference;
        regeneratePurchaseReference = () => {
            purchase_reference = getUUID();
        };
    };