/*
 * Herbert's lines, in one place. English only for the prototype; when he moves
 * into the app these go through the six-language catalogs (src/locales/).
 * Plain words, short: the speech bubble is 200 px wide.
 */
window.HERBERT_TEXTS = {
    // Said once when the window opens, by the hour of the day.
    greetingMorning: 'Good morning! Herbert reporting for duty.',
    greetingAfternoon: 'Good afternoon! Your calendars are in good hooves.',
    greetingEvening: 'Good evening! Still delivering, same as always.',
    greetingNight: 'Up late? I’ll keep watch. Rest when you can.',

    // Everything is fine.
    content: 'All is well. Everything is in sync.',

    // A sync failed.
    worried: 'Oh no, a sync went wrong. Please have a look at the app.',

    // A sample line for the demo's "Talking" button.
    talkingSample: 'Express delivery, straight across the rainbow bridge!',

    // Now and then, never more than one at a time, never while he sleeps or worries.
    encouragements: [
        'Just so you know: you’re amazing.',
        'Whatever today brings, you’ve got this.',
        'A small reminder that you’re doing great.',
        'You’re doing better than you think.',
        'Take a breath. You’re wonderful.',
        'You showed up today. That already counts.',
        'Somebody is glad you exist. I’m one of them.',
        'You handle more than most people ever see.',
        'Your calendar is full because people want you there.',
        'Not everything is urgent. You’re allowed to breathe.',
        'You’ve made it through every hard day so far. Full score.',
        'The way you keep going is quietly heroic.',
        'You don’t need to be perfect to be wonderful.',
        'A unicorn believes in you. That’s official.',
        'Whatever you’re working on is lucky to have you.',
        'Kindness like yours is rarer than unicorns.',
        'Rest is part of the work. You’ve earned some.',
        'You notice things other people miss. That’s a gift.',
        'If today is heavy, tomorrow gets a fresh page.',
        'Someone remembers something nice you did. Promise.',
        'You make this little bridge worth running.',
        'Your best is enough. It always was.',
        'Even unicorns have off days. You’re still amazing.',
        'You’re not behind. You’re exactly where the day is.',
        'Proud of you. No reason needed.',
    ],

    // Reactions to things that happen while the bridge runs (herbert.react(name)).
    // The key is the event; the pose that goes with it is in herbert.js.
    reactions: {
        delivered: 'Delivered! Your change is in Proton.',
        incoming: 'New mail for your calendar.',
        invitation: 'You’ve been invited somewhere!',
        answered: 'Your answer is on its way to the organizer.',
        cancelled: 'That meeting is off. More time for you.',
        refused: 'Proton can’t do that one. Sorry!',
        slowdown: 'Proton says: easy now. We’ll wait a moment.',
        online: 'Back online! Catching up now.',
        wake: 'Mmh… good to see you again.',
        signedIn: 'Welcome aboard!',
        signInNeeded: 'Proton would like you to sign in again.',
        appConnected: 'Your calendar app found me. Hello!',
        appMissing: 'Is your calendar app still around? I’m right here.',
        updateAvailable: 'There’s a new version waiting. Fancy!',
        refresh: 'Full check-up, every corner of every calendar.',
        quiet: 'All quiet. I’m humming to myself.',
        busyDay: 'Busy day ahead. I’ve got your back.',
        freeDay: 'Nothing on today. Enjoy it!',
        poke: 'Hehe, that tickles.',
        thanks: 'Thank you for keeping me in oats!',
    },
};
