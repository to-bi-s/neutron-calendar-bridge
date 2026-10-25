/**
 * Offline test for the invitation emails' languages (0.31): Proton's own translations, extracted
 * from WebClients, applied to the vendored email builders for the moment an email is built —
 * the subject and body in German (text and date), English again afterwards, a code Proton's
 * setting may give (de, es_MX) matched to a language, an unknown code or a partly translated
 * language falling back to English per string, and the API's policy refusing an unknown language.
 */
import { ICAL_METHOD } from '@proton/shared/lib/calendar/constants';
import { generateEmailBody, generateEmailSubject } from '@proton/shared/lib/calendar/mailIntegration/invite';

import {
    DEFAULT_INVITATION_LANGUAGE,
    INVITATION_LANGUAGES,
    dateFnsLocaleForRegion,
    dateParamsFor,
    inInvitationLanguage,
    matchInvitationLanguage,
    prepareInvitationLanguage,
} from '../src/invitation-language.ts';
import { INVITATION_LOCALE_SOURCE } from '../src/invitation-locales.generated.ts';
import { ProtonCalendarAPI } from '../src/proton-calendar-api.ts';

let failures = 0;
const check = (condition: unknown, label: string) => {
    console.log(`${condition ? 'ok  ' : 'FAIL'} ${label}`);
    if (!condition) failures += 1;
};

const vevent: any = {
    component: 'vevent',
    uid: { value: 'test-uid@proton.me' },
    summary: { value: 'Team lunch' },
    dtstart: { value: { year: 2026, month: 3, day: 16, hours: 12, minutes: 30, seconds: 0, isUTC: true } },
    dtend: { value: { year: 2026, month: 3, day: 16, hours: 13, minutes: 30, seconds: 0, isUTC: true } },
    sequence: { value: 0 },
};
const subjectOf = (language: Awaited<ReturnType<typeof prepareInvitationLanguage>> | null) =>
    inInvitationLanguage(language, () => generateEmailSubject({ method: ICAL_METHOD.REQUEST, vevent, isCreateEvent: true, ...dateParamsFor(language) }));
const bodyOf = (language: Awaited<ReturnType<typeof prepareInvitationLanguage>> | null) =>
    inInvitationLanguage(language, () => generateEmailBody({ method: ICAL_METHOD.REQUEST, vevent, isCreateEvent: true, ...dateParamsFor(language) } as any));

const main = async () => {
    console.log('--- the languages');
    check(INVITATION_LANGUAGES.length >= 30 && INVITATION_LANGUAGES[0].code === 'en_US', `${INVITATION_LANGUAGES.length} languages, English first`);
    check(INVITATION_LANGUAGES.filter((language) => language.translated === language.of).length >= 30, 'nearly all fully translated');
    check(/^[0-9a-f]{40}$/.test(INVITATION_LOCALE_SOURCE.commit), `from WebClients ${INVITATION_LOCALE_SOURCE.commit.slice(0, 10)}`);
    check(matchInvitationLanguage('de_DE')?.code === 'de_DE' && matchInvitationLanguage('de')?.code === 'de_DE' && matchInvitationLanguage('de-DE')?.code === 'de_DE', 'de, de-DE and de_DE are German');
    check(matchInvitationLanguage('es_MX')?.code.startsWith('es_'), 'a Spanish code Proton does not list is matched to Spanish');
    check(matchInvitationLanguage('xx_XX') === null && matchInvitationLanguage(null) === null && matchInvitationLanguage('') === null, 'unknown and empty: none');

    console.log('--- an email in German');
    const english = subjectOf(null);
    check(/^Invitation for an event (starting )?on .*Monday/.test(english), `English subject: ${english}`);
    const german = await prepareInvitationLanguage('de_DE');
    check(german.code === 'de_DE' && german.dateFnsLocale?.code === 'de', 'German prepared with the German date locale');
    const subject = subjectOf(german);
    check(/^Einladung zu einem Termin.*Montag.*März/.test(subject), `German subject with a German date: ${subject}`);
    const body = bodyOf(german);
    check(/eingeladen/.test(body) && /Team lunch/.test(body) && /Montag/.test(body), `German body with the title and a German date: ${body.replace(/\s+/g, ' ').slice(0, 160)}`);
    const reply = inInvitationLanguage(german, () => generateEmailSubject({ method: ICAL_METHOD.REPLY, vevent, partstat: 'ACCEPTED' as any, ...dateParamsFor(german) }));
    check(/^AW: Einladung/.test(reply), `a German answer starts with "AW:" like Proton's: ${reply}`);
    check(subjectOf(null) === english, 'English again afterwards');
    const germanAgain = await prepareInvitationLanguage('de');
    check(subjectOf(germanAgain) === subject, 'the same again (registered once)');

    console.log('--- fallbacks');
    const unknown = await prepareInvitationLanguage('xx_XX');
    check(unknown.code === DEFAULT_INVITATION_LANGUAGE && subjectOf(unknown) === english, 'an unknown code: English');
    const japanese = await prepareInvitationLanguage('ja_JP');
    check(subjectOf(japanese) !== english && /2026/.test(subjectOf(japanese)), `Japanese: ${subjectOf(japanese)}`);
    const kabyle = INVITATION_LANGUAGES.find((language) => language.code === 'kab_DZ');
    if (kabyle) {
        const prepared = await prepareInvitationLanguage('kab_DZ');
        const kabyleSubject = subjectOf(prepared);
        check(kabyle.translated < kabyle.of, `Kabyle is partly translated (${kabyle.translated}/${kabyle.of})`);
        check(kabyleSubject.length > 0 && (kabyleSubject === english || !/Invitation for an event on/.test(kabyleSubject) || /Monday/.test(kabyleSubject)), `a missing string stays English per string: ${kabyleSubject}`);
    }
    const noDates = INVITATION_LANGUAGES.find((language) => language.dateFns === null);
    if (noDates) {
        const prepared = await prepareInvitationLanguage(noDates.code);
        check(prepared.code === noDates.code && prepared.dateFnsLocale === null && /Monday/.test(subjectOf(prepared)), `${noDates.code} has no date-fns locale: English dates`);
    }

    console.log('--- the date format (0.49.6): the region and the hours, as Proton Calendar web on the same Mac');
    check(dateFnsLocaleForRegion('en-GB') === 'en-GB' && dateFnsLocaleForRegion('nl-NL') === 'nl' && dateFnsLocaleForRegion('en-NL') === 'en-GB' && dateFnsLocaleForRegion('en-US') === 'en-US' && dateFnsLocaleForRegion('de_AT') === 'de-AT' && dateFnsLocaleForRegion('xx') === null, 'region → date-fns locale');
    const british = await prepareInvitationLanguage('en_US', { region: 'en-NL' });
    const britishSubject = subjectOf(british);
    check(/Monday 16 March 2026 at 12:30/.test(britishSubject), `English words, a European region: ${britishSubject}`);
    check(/^Invitation for an event (starting )?on .*Monday March 16th, 2026 at 12:30 PM/.test(english), `the US form stays without a region: ${english}`);
    const twelve = await prepareInvitationLanguage('en_US', { region: 'en-GB', timeFormat: 12 });
    check(/16 March 2026 at 12:30 PM/.test(subjectOf(twelve)), `the account's 12-hour setting over the region's: ${subjectOf(twelve)}`);
    const germanDutch = await prepareInvitationLanguage('de_DE', { region: 'nl-NL', timeFormat: 24 });
    const germanDutchSubject = subjectOf(germanDutch);
    check(/Montag 16 maart|Montag 16 März 2026/.test(germanDutchSubject) && /12:30/.test(germanDutchSubject) && !/PM/.test(germanDutchSubject), `German words in the Dutch long format: ${germanDutchSubject}`);
    const sameRegion = await prepareInvitationLanguage('de_DE', { region: 'de-DE' });
    check(subjectOf(sameRegion) === subject, 'the language\'s own region changes nothing');
    const usTwentyFour = await prepareInvitationLanguage('en_US', { region: 'en-US', timeFormat: 24 });
    check(/March 16th, 2026 at 12:30$/.test(subjectOf(usTwentyFour).replace(/ \(GMT.*$/, '')), `US dates in 24 hours: ${subjectOf(usTwentyFour)}`);

    console.log('--- the API policy');
    const api: any = new ProtonCalendarAPI({ username: '', password: '' });
    check(api.getInvitationEmailPolicy().language === 'proton', "the default is Proton Calendar's setting");
    api.configureInvitations({ policy: { mode: 'test', allowlist: [], language: 'nl_NL' } });
    check(api.getInvitationEmailPolicy().language === 'nl_NL', 'a fixed language is kept');
    let refused = '';
    try {
        api.configureInvitations({ policy: { mode: 'test', allowlist: [], language: 'klingon' } });
    } catch (error: any) {
        refused = error.message;
    }
    check(/Unknown invitation email language: klingon/.test(refused), 'an unknown language is refused');
    api.configureInvitations({ policy: { mode: 'test', allowlist: [] } });
    check(api.getInvitationEmailPolicy().language === 'proton', 'left out: back to Proton Calendar\'s setting');

    console.log(failures ? `\n${failures} check(s) failed` : '\nAll invitation language checks passed');
    process.exit(failures ? 1 : 0);
};

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
