// Functions for the damage card
import {
    BRSW_CONST, BRWSRoll, create_common_card, get_actor_from_message, are_bennies_available,
    roll_trait, spend_bennie, update_message
} from "./cards_common.js";
import {create_incapacitation_card, create_injury_card} from "./incapacitation_card.js";

/**
 * Shows a damage card and applies damage to the token/actor
 * @param {string} token_id
 * @param {int} damage
 * @param {string} damage_text
 */
export async function create_damage_card(token_id, damage, damage_text) {
    let token = canvas.tokens.get(token_id);
    let actor = token.actor;
    let user = get_owner(actor);
    // noinspection JSUnresolvedVariable
    let undo_values = {wounds: actor.data.data.wounds.value,
        shaken: actor.data.data.status.isShaken};
    const wounds = Math.floor(damage / 4)
    // noinspection JSUnresolvedVariable
    const can_soak = wounds || actor.data.data.status.isShaken;
    const damage_result = await apply_damage(token, wounds, 0);
    const footer = damage_card_footer(actor);
    const show_injury = (game.settings.get(
        'betterrolls-swade2', 'optional_rules_enabled').indexOf(
            "GrittyDamage") > -1) && can_soak && (actor.data.data.wounds.max > 1);
    let trait_roll = new BRWSRoll();
    let message = await create_common_card(token,
    {header: {type: game.i18n.localize("SWADE.Dmg"),
        title: game.i18n.localize("SWADE.Dmg"),
        notes: damage_text}, text: damage_result.text, footer: footer,
        undo_values: undo_values, trait_roll: trait_roll, wounds: wounds,
        soaked: 0, soak_possible: (are_bennies_available(actor) && can_soak),
        show_incapacitation: damage_result.incapacitated && actor.isWildcard,
        show_injury: show_injury},
        CONST.CHAT_MESSAGE_TYPES.ROLL,
    "modules/betterrolls-swade2/templates/damage_card.html")
    await message.update({user: user._id});
    await message.setFlag('betterrolls-swade2', 'attribute_id', 'vigor');
    await message.setFlag('betterrolls-swade2', 'card_type',
        BRSW_CONST.TYPE_DMG_CARD)
    return message
}


/**
 * Creates the footer for damage and incapacitation cards
 * @param {{SwadeActor}} actor
 * @return {[string]}
 */
function damage_card_footer(actor){
    // noinspection JSUnresolvedVariable
    let footer = [`${game.i18n.localize("SWADE.Wounds")}: ${actor.data.data.wounds.value}/${actor.data.data.wounds.max}`]
    // noinspection JSUnresolvedVariable
    for (let status in actor.data.data.status) {
        // noinspection JSUnfilteredForInLoop,JSUnresolvedVariable
        if (actor.data.data.status[status]) {
            // noinspection JSUnfilteredForInLoop
            footer.push(status.slice(2));
        }
    }
    return footer
}


/**
 * Gets the owner of an actor
 * @param {SwadeActor} actor
 */
export function get_owner(actor) {
    let player;
    let gm;
    game.users.forEach(user => {
        if (user.isGM) {
            gm = user
        } else {
            if (user.character && user.character.id === actor.id) {
                player = user
            }
        }
    })
    return player || gm;
}


/**
 * Applies damage to a token
 * @param token
 * @param {int} wounds
 * @param {int} soaked
 */
async function apply_damage(token, wounds, soaked=0) {
    if (wounds < 0) return;
    let incapacitated = false;
    if (!(token instanceof Token)) {
        // If this is not a token then it is a token id
        token = canvas.tokens.get(token);
    }
    // We take the starting situation
    let initial_wounds = token.actor.data.data.wounds.value;
    // noinspection JSUnresolvedVariable
    let initial_shaken = token.actor.data.data.status.isShaken;
    // We test for double shaken
    let damage_wounds = wounds;
    let final_shaken = true; // Any damage also shakes the token
    let text = ''
    if (wounds < 1 && initial_shaken) {
        // Shaken twice
        if (token.actor.data.items.find(item => {
            return item.name.toLowerCase().includes(
                game.i18n.localize("BRSW.HardyIdentifier")) && item.type === "edge";
            })) {
            text += game.i18n.localize("BRSW.HardyActivated");
            damage_wounds = 0
        } else {
            damage_wounds = 1;
        }
    }
    text += wounds ? game.i18n.format(
        "BRSW.TokenWounded", {token_name:token.name, wounds: wounds}) :
        (damage_wounds ? game.i18n.format("BRSW.DoubleShaken",
            {token_name: token.name}) :
            game.i18n.format("BRSW.TokenShaken", {token_name:token.name}));
    // Now we look for soaking
    if (soaked) {
        damage_wounds = damage_wounds - soaked;
        if (damage_wounds <= 0) {
            // All damage soaked, remove shaken
            damage_wounds = 0;
            final_shaken = false;
            text += game.i18n.localize("BRSW.AllSoaked");
        } else {
            text += game.i18n.format("BRSW.SomeSoaked", {soaked: soaked});
        }
    }
    // Final damage
    let final_wounds = initial_wounds + damage_wounds;
    if (final_wounds > token.actor.data.data.wounds.max) {
        incapacitated = true;
        // Mark as defeated if the token is in a combat
        game.combat?.combatants.forEach(combatant => {
            if (combatant.token._id === token.id) {
                token.update({overlayEffect: 'icons/svg/skull.svg'});
                game.combat.updateCombatant(
                    {_id: combatant._id, defeated: true});
            }
        });
    }
    // We cap damage on actor number of wounds
    final_wounds = Math.min(final_wounds, token.actor.data.data.wounds.max)
    // Finally we update actor and mark defeated
    let actorUpdate = {'data.wounds.value': final_wounds};  // create object for actor update (we may not need to update shaken if it's handled by active effect)
    let updateShaken = true; // We don't need to update shaken value if it's handled by status effect changes
    let shakenEffectExists = token.actor.effects.find(e => e.getFlag('core', 'statusId') === "shaken"); // Does a shaken status effect exist on the actor?
    if (shakenEffectExists) {
        if (shakenEffectExists.hasOwnProperty('changes')) {
            if (shakenEffectExists.changes.find(e => (e.key === "data.status.isShaken" && e.value === "true"))) {
                // shaken is entirely handled by the status effect, we don't need to update data.status.isShaken
            updateShaken = false;
            }
        }
    }
    if (shakenEffectExists && !final_shaken) {
        // Actor has shaken effect, but should not be shaken
        shakenEffectExists.delete();  // remove the status effect
    } else if (!shakenEffectExists && final_shaken) {
        // Actor does not have a shaken status effect but should be shaken
        let shakenEffect = foundry.utils.deepClone(CONFIG.SWADE.statusEffects.find(e => e.id === "shaken"));
        shakenEffect.label = game.i18n.localize("SWADE.Shaken");
        shakenEffect["flags.core.statusId"] = "shaken";
        delete shakenEffect.id;
        const cls = getDocumentClass("ActiveEffect");
        await cls.create(shakenEffect, {parent: token.actor});
        if (shakenEffect.hasOwnProperty('changes')) {
            if (shakenEffect.changes.find(e => (e.key === "data.status.isShaken" && e.value === "true"))) {
                // shaken is entirely handled by the status effect, we don't need to update data.status.isShaken
                updateShaken = false;
            }
        }
    }

    if (updateShaken == true) {
        actorUpdate["data.status.isShaken"] = final_shaken;  // add shaken update to actor update if it's not handled by status effect
    }
    token.actor.update(actorUpdate);

    return {text: text, incapacitated: incapacitated};
}


/**
 * Undo the damage in one card
 * @param {ChatMessage} message
 */
async function undo_damage(message){
    const actor = get_actor_from_message(message);
    const render_data = message.getFlag('betterrolls-swade2',
        'render_data');
    const actorUpdate = {"data.wounds.value": render_data.undo_values.wounds}; // create object for actor update (we may not need to update shaken if it's handled by active effect)
    let updateShaken = true;
    let undoValueShaken = render_data.undo_values.shaken; // what do we want shaken to be after undo
    const shakenEffectExists = actor.effects.find(e=> e.getFlag('core', 'statusId') === 'shaken'); // does the actor already have shaken active effect?
    if (shakenEffectExists) {
        if (shakenEffectExists.hasOwnProperty('changes')) {
            if (shakenEffectExists.changes.find(e => (e.key === "data.status.isShaken" && e.value === "true"))) {
                // shaken is entirely handled by the status effect, we don't need to update data.status.isShaken
            updateShaken = false;
            }
        }
    }
    if (shakenEffectExists && !undoValueShaken) {
        // actor has a shaken active effect, and after undo actor should not be shaken
        shakenEffectExists.delete();
    } else if (!shakenEffectExists && undoValueShaken) {
        // actor does not have a shaken active effect, and after undo actor should be shaken
        let shakenEffect = foundry.utils.deepClone(CONFIG.SWADE.statusEffects.find(e => e.id === "shaken"));
        shakenEffect.label = game.i18n.localize("SWADE.Shaken");
        shakenEffect["flags.core.statusId"] = "shaken";
        delete shakenEffect.id;
        const cls = getDocumentClass("ActiveEffect");
        await cls.create(shakenEffect, {parent: actor});
        if (shakenEffect.hasOwnProperty('changes')) {
            if (shakenEffect.changes.find(e => (e.key === "data.status.isShaken" && e.value === "true"))) {
                // the shaken active effect "changes" section is already setting the data.status.isShaken, we don't need to update it
                updateShaken = false;
            }
        }
    }
    if (updateShaken == true) {
        actorUpdate["data.status.isShaken"] = undoValueShaken;
    }
    await actor.update(actorUpdate);
    
    const token = message.getFlag('betterrolls-swade2', 'token');
    if (token) {
        game.combat?.combatants.forEach(combatant => {
            if (combatant.tokenId === token) {
                canvas.tokens.get(token).update({overlayEffect: ''});
                game.combat.updateCombatant(
                    {_id: combatant._id, defeated: false});
            }
        });
    }
    await message.delete();
}


/**
 * Activate the listeners of the damage card
 * @param message: Message date
 * @param html: Html produced
 */
export function activate_damage_card_listeners(message, html) {
    html.find('.brsw-undo-damage').click(async () =>{
        await undo_damage(message);
    });
    html.find('.brsw-soak-button, .brsw-roll-button').click((ev) =>{
        let spend_bennie = false
        if (ev.currentTarget.classList.contains('roll-bennie-button') ||
                ev.currentTarget.classList.contains('brsw-soak-button')) {
            spend_bennie=true
        }
        // noinspection JSIgnoredPromiseFromCall
        roll_soak(message, spend_bennie);
    });
    html.find('.brsw-show-incapacitation').click(() => {
        // noinspection JSIgnoredPromiseFromCall
        create_incapacitation_card(message.getFlag('betterrolls-swade2', 'token'))
    });
    html.find('.brsw-injury-button').click(() => {
        // noinspection JSIgnoredPromiseFromCall
        create_injury_card(message.getFlag('betterrolls-swade2', 'token'))
    })
}

/**
 * Males a soak roll
 * @param {ChatMessage} message
 * @param {Boolean} use_bennie
 */
async function roll_soak(message, use_bennie) {
    const render_data = message.getFlag('betterrolls-swade2',
        'render_data');
    const actor = get_actor_from_message(message);
    if (use_bennie) {
        await spend_bennie(actor);
    }
    const undo_wound_modifier = Math.min(actor.data.data.wounds.value, 3) -
        render_data.undo_values.wounds;
    const roll = await roll_trait(message,
        actor.data.data.attributes.vigor, game.i18n.localize("BRSW.SoakRoll"),
        '', {modifiers:[
            {name: game.i18n.localize("BRSW.RemoveWounds"),
                value: undo_wound_modifier}]});
    let result = 0;
    roll.rolls.forEach(roll => {
        result = Math.max(roll.result, result);
    })
    roll.old_rolls.forEach(old_roll => {
        old_roll.forEach(roll => {
            result = Math.max(roll.result, result);
        })
    })
    if (result >= 4) {
        render_data.soaked = Math.floor(result / 4);
        await actor.update({"data.wounds.value": render_data.undo_values.wounds,
            "data.status.isShaken": render_data.undo_values.shaken});
        const damage_result = (await apply_damage(message.getFlag(
            'betterrolls-swade2', 'token'), render_data.wounds,
            render_data.soaked));
        render_data.text = damage_result.text
        render_data.show_incapacitation = damage_result.incapacitated &&
            actor.isWildcard;
        render_data.show_injury = (game.settings.get(
        'betterrolls-swade2', 'optional_rules_enabled').indexOf(
            "GrittyDamage") > -1) && (render_data.wounds > render_data.soaked)
        await update_message(message, actor, render_data);
    }
}
